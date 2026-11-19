import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { APP, USER, draft, type DraftEvent, type EventEnvelope } from '../../shared/events';
import { assignName } from '../../shared/naming';
import { parseBatch } from '../../shared/batch';
import {
  LIVE_SESSION_STATES,
  TERMINAL_TASK_STATUSES,
  type AttentionItem,
  type PendingEvent,
  type Session,
  type SessionState,
  type Task,
  type TaskStatus,
} from '../../shared/types';
import { Bus, type BusHandlers, type Identity } from '../bus/server';
import { ToolError, type ToolName } from '../bus/tools';
import { DeliveryEngine } from '../delivery/engine';
import { evaluateFloor, ruleMatches } from '../policy/floor';
import { PtyManager, type PtySession } from '../pty/pty-manager';
import { LIMIT_PATTERNS } from '../pty/dialogs';
import { abPaths, buildEnv, claudeArgs, managerSettings, mcpConfig, workerSettings, writeSessionFiles } from '../pty/session-files';
import { canTransition } from '../store/reducer';
import type { StateHub } from '../store/state-hub';
import { renderBoard } from '../store/board-md';
import { UsageMonitor, totalCost, totalTokens } from '../usage/monitor';
import { scanSkills, writeSkill, parseFrontmatter } from '../skills/catalog';
import * as gitsvc from '../work/git';
import { realClock, type Clock } from '../attention/scheduler';

export interface RepoConfig {
  path: string;
  base_branch?: string;
  setup_cmd?: string;
  copy_files?: string[];
  allow_bash?: string[];
}

export interface OrchestratorDeps {
  hub: StateHub;
  ptys: PtyManager;
  home: string;
  resources: string;
  claudePath: string;
  loginPath: string;
  baseEnv: NodeJS.ProcessEnv;
  clock?: Clock;
  /** for tests: CLAUDE_CONFIG_DIR passed to sessions */
  configDir?: string;
  /** disable channel (forces paste fallback) */
  disableChannel?: boolean;
  /** native messaging unavailable -> Fallback B worker tools */
  fallbackB?: boolean;
}

const READY_TIMEOUT_MS = 90_000;
const PERMISSION_HOLD_MS = 30_000;
const STALL_MS = { worker: 10 * 60_000, manager: 20 * 60_000 };
const IDLE_WITHOUT_DONE_MS = 30 * 60_000;
const NOTIFIERS = new Set(['osascript', 'terminal-notifier', 'say', 'afplay', 'alerter', 'growlnotify']);

const MANAGER_NAME = 'manager';

export class Orchestrator extends EventEmitter implements BusHandlers {
  readonly bus: Bus;
  readonly usage = new UsageMonitor();
  readonly delivery: DeliveryEngine;
  readonly paths: ReturnType<typeof abPaths>;
  private clock: Clock;
  private stopping = new Set<string>();
  private permissionWaiters = new Map<string, (d: { decision: 'allow' | 'deny'; message?: string }) => void>();
  private inFlightTools = new Map<string, number>();
  private flaggedIdle = new Set<string>();
  private managerCrashes: number[] = [];
  private boardTimer?: NodeJS.Timeout;
  private ticker?: NodeJS.Timeout;
  private shuttingDown = false;

  constructor(readonly d: OrchestratorDeps) {
    super();
    this.clock = d.clock ?? realClock;
    this.paths = abPaths(d.home);
    this.bus = new Bus(this);
    this.delivery = new DeliveryEngine(
      d.hub,
      {
        managerSession: () => this.liveManager()?.id,
        channelReady: (s) => !d.disableChannel && this.bus.hasChannel(s),
        pushChannel: (s, c, m) => this.bus.pushChannel(s, c, m),
        canPaste: (s) => {
          const sess = this.hub.state.sessions[s];
          const p = d.ptys.get(s);
          return !!p && !!sess && ['idle', 'ready'].includes(sess.state) && !p.userActive();
        },
        paste: (s, text) => d.ptys.get(s)!.injectPaste(text),
        raiseUnacked: async (ev) => {
          await this.raiseAppItem(`The manager has not acted on agentboard event ${ev.id} (${ev.kind}) after ${ev.pushes} deliveries.`, ev.content.slice(0, 300));
        },
      },
      this.clock,
    );
    d.hub.on('events', (evs: EventEnvelope[]) => this.onEvents(evs));
  }

  get hub(): StateHub {
    return this.d.hub;
  }

  fallbackB(): boolean {
    return !!this.d.fallbackB;
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  async start(): Promise<void> {
    for (const dir of [this.paths.manager, this.paths.tasks, this.paths.sessions, this.paths.worktrees, this.paths.workspaces, this.paths.logs]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.installShims();
    await this.bus.start();
    this.delivery.boot();
    this.killOrphans();
    this.ticker = setInterval(() => void this.tick(), 5_000);
    this.renderBoardSoon();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.ticker) clearInterval(this.ticker);
    for (const s of this.d.ptys.sessions.keys()) this.stopping.add(s);
    this.d.ptys.killAll();
    await this.bus.stop();
  }

  private installShims(): void {
    const src = path.join(this.d.resources, 'bin', 'shims');
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(this.paths.shims, { recursive: true });
    for (const f of fs.readdirSync(src)) {
      fs.copyFileSync(path.join(src, f), path.join(this.paths.shims, f));
      fs.chmodSync(path.join(this.paths.shims, f), 0o755);
    }
  }

  /** Kill recorded claude pids that survived an app crash before resuming them (SPEC §18.3). */
  private killOrphans(): void {
    for (const s of Object.values(this.hub.state.sessions)) {
      if (!s.pid) continue;
      try {
        const cmd = fs.existsSync(`/proc/${s.pid}/cmdline`) ? fs.readFileSync(`/proc/${s.pid}/cmdline`, 'utf8') : '';
        process.kill(s.pid, 0);
        if (!cmd || (cmd.includes('claude') && cmd.includes(s.id))) process.kill(s.pid, 'SIGTERM');
      } catch {
        /* not running */
      }
    }
  }

  liveManager(): Session | undefined {
    const id = this.hub.state.managerSession;
    const s = id ? this.hub.state.sessions[id] : undefined;
    return s && this.d.ptys.get(s.id) ? s : undefined;
  }

  /** Start or resume the manager, then resume interrupted workers (staggered). */
  async resumeAll(): Promise<void> {
    await this.ensureManager();
    const workers = Object.values(this.hub.state.sessions).filter(
      (s) => s.role === 'worker' && ['interrupted', 'crashed'].includes(s.state) && !s.cleanedUp && s.taskId && !TERMINAL_TASK_STATUSES.includes(this.hub.state.tasks[s.taskId]?.status),
    );
    for (const w of workers) {
      await new Promise((r) => setTimeout(r, 3000));
      if (this.shuttingDown) return;
      await this.spawnSession(w, true).catch(() => undefined);
    }
  }

  async ensureManager(): Promise<void> {
    if (this.liveManager()) return;
    const prev = this.hub.state.managerSession ? this.hub.state.sessions[this.hub.state.managerSession] : undefined;
    const session: Session =
      prev ??
      ({ id: randomUUID(), role: 'manager', name: MANAGER_NAME, cwd: this.paths.manager, state: 'spawning', stateSince: '', crashCount: 0, cleanedUp: false, resumeCount: 0 } as Session);
    await this.spawnSession(session, !!prev);
  }

  private async spawnSession(sess: Session, resume: boolean, extra: { startPrompt?: string; model?: string; addDirs?: string[]; mcpServers?: string[]; extraAllow?: string[] } = {}): Promise<PtySession> {
    const isMgr = sess.role === 'manager';
    const task = sess.taskId ? this.hub.state.tasks[sess.taskId] : undefined;
    const id: Identity = { role: sess.role, session: sess.id, name: sess.name, worker: sess.workerId, task: sess.taskId };
    const token = this.bus.tokens.issue(id);
    const dir = path.join(this.paths.sessions, sess.id);
    const repoCfg = task?.repo ? this.repoConfig(task.repo) : undefined;
    const extraMcp = this.mcpServersFor(extra.mcpServers ?? task?.mcpServers ?? []);
    const channel = isMgr && !this.d.disableChannel;
    const files = writeSessionFiles(dir, {
      settings: isMgr
        ? managerSettings({ home: this.d.home, resources: this.d.resources })
        : workerSettings({ home: this.d.home, resources: this.d.resources, repoAllowBash: repoCfg?.allow_bash, extraAllow: extra.extraAllow }),
      mcp: mcpConfig(this.bus.url, extraMcp, channel),
      systemAppend: fs.readFileSync(path.join(this.d.resources, 'prompts', isMgr ? 'manager.md' : 'worker.md'), 'utf8'),
    });
    const startPrompt =
      extra.startPrompt ??
      (isMgr
        ? resume
          ? 'agentboard restarted. Re-sync: call list_tasks, list_workers and list_attention, then handle any pending events.'
          : 'agentboard started. Call list_tasks and list_attention, then wait for events and user requests.'
        : resume
          ? `agentboard restarted. Continue task ${sess.taskId}; re-read your brief at ${path.join(this.paths.tasks, sess.taskId ?? '', 'brief.md')} if needed.`
          : undefined);
    const args = claudeArgs({
      sessionId: sess.id,
      resume,
      name: sess.name,
      model: extra.model ?? this.hub.state.config.defaultModel,
      permissionMode: isMgr ? 'default' : 'acceptEdits',
      files,
      addDirs: extra.addDirs,
      channel,
      startPrompt,
    });
    const env = buildEnv({
      base: this.d.baseEnv,
      path: this.d.loginPath,
      role: sess.role,
      session: sess.id,
      name: sess.name,
      token,
      busUrl: this.bus.url,
      shimsDir: this.paths.shims,
      worker: sess.workerId,
      task: sess.taskId,
      configDir: this.d.configDir,
    });
    await this.hub.commit(draft('session.spawn_requested', APP, { session: sess.id, role: sess.role, name: sess.name, worker: sess.workerId, task: sess.taskId, cwd: sess.cwd, resume }));
    fs.mkdirSync(sess.cwd, { recursive: true });
    const pty = this.d.ptys.spawn({ session: sess.id, file: this.d.claudePath, args, cwd: sess.cwd, env });
    await this.hub.commit(draft('session.started', APP, { session: sess.id, pid: pty.pid }));
    pty.on('ready', () => {
      const cur = this.hub.state.sessions[sess.id]?.state;
      if (cur === 'spawning' || cur === 'needs_user_dialog') void this.setState(sess.id, 'ready', 'screen');
    });
    pty.on('dialog', (dl: { id: string; needsUser: boolean }) => void this.onDialog(sess.id, dl));
    pty.on('data', (data: string) => this.onPtyData(sess.id, data));
    pty.on('exit', (e: { exitCode: number; signal?: number }) => void this.onExit(sess.id, e));
    this.emit('pty', sess.id);
    return pty;
  }

  private repoConfig(repo: string): RepoConfig | undefined {
    try {
      const all = JSON.parse(fs.readFileSync(this.paths.repos, 'utf8')) as { repos?: Record<string, RepoConfig> };
      const entries = Object.entries(all.repos ?? {});
      const hit = entries.find(([k, v]) => k === repo || path.resolve(v.path) === path.resolve(repo));
      return hit ? hit[1] : { path: repo };
    } catch {
      return { path: repo };
    }
  }

  private mcpServersFor(names: string[]): Record<string, unknown> {
    if (!names.length) return {};
    let cat: Record<string, unknown> = {};
    try {
      cat = JSON.parse(fs.readFileSync(this.paths.mcpCatalog, 'utf8'));
    } catch {
      /* none */
    }
    const out: Record<string, unknown> = {};
    for (const n of names) {
      if (!cat[n]) throw new ToolError('INVALID_ARGUMENT', `MCP server "${n}" is not in ${this.paths.mcpCatalog}`);
      if (n === 'agentboard') continue;
      out[n] = cat[n];
    }
    return out;
  }

  private async setState(session: string, state: SessionState, source: string): Promise<void> {
    const s = this.hub.state.sessions[session];
    if (!s || s.state === state) return;
    if (['exited', 'crashed'].includes(s.state)) return;
    if (s.state === 'finished' && !['exiting', 'exited', 'crashed'].includes(state)) return;
    await this.hub.commit(draft('session.state_changed', APP, { session, state, source }));
  }

  private lastDataCommit = new Map<string, number>();
  private onPtyData(session: string, data: string): void {
    this.emit('pty-data', session, data);
    const now = this.clock.now();
    if (LIMIT_PATTERNS.some((re) => re.test(data)) && !this.hub.state.usage.paused) {
      void this.hub.commit(draft('usage.limit_hit', APP, { source: 'pty' }));
    }
    if (now - (this.lastDataCommit.get(session) ?? 0) > 60_000) this.lastDataCommit.set(session, now);
  }

  private async onDialog(session: string, dl: { id: string; needsUser: boolean }): Promise<void> {
    if (!dl.needsUser) return;
    const s = this.hub.state.sessions[session];
    if (!s || s.state === 'needs_user_dialog') return;
    await this.setState(session, 'needs_user_dialog', `dialog:${dl.id}`);
    await this.raiseAppItem(
      `${s.name} is waiting on a Claude Code screen (${dl.id}) that agentboard cannot answer. Open its tab and complete it.`,
      'This usually happens once (first run, login, or a new Claude Code prompt).',
      s.workerId,
      s.taskId,
    );
  }

  private async onExit(session: string, e: { exitCode: number; signal?: number }): Promise<void> {
    const s = this.hub.state.sessions[session];
    this.bus.tokens.revoke(session);
    this.bus.dropSession(session);
    if (!s || this.shuttingDown) {
      if (s && this.shuttingDown) await this.hub.commit(draft('session.exited', APP, { session, exitCode: e.exitCode, signal: e.signal, expected: true })).catch(() => undefined);
      return;
    }
    const expected = this.stopping.has(session) || s.state === 'finished';
    this.stopping.delete(session);
    await this.hub.commit(draft('session.exited', APP, { session, exitCode: e.exitCode, signal: e.signal, expected }));
    if (expected) return;
    const after = this.hub.state.sessions[session];
    if (s.role === 'manager') {
      const now = this.clock.now();
      this.managerCrashes = this.managerCrashes.filter((t) => now - t < 10 * 60_000);
      this.managerCrashes.push(now);
      if (this.managerCrashes.length >= 3) {
        if (!this.hub.state.usage.paused) await this.hub.commit(draft('usage.limit_hit', APP, { source: 'manager_crash_loop' }));
        await this.raiseAppItem('The manager keeps crashing (3 times in 10 minutes). Spawning is paused.', `Last exit code ${e.exitCode}. Open the Manager tab to see what happened.`);
        return;
      }
      setTimeout(() => void this.ensureManager().catch(() => undefined), 2000);
      return;
    }
    const task = s.taskId ? this.hub.state.tasks[s.taskId] : undefined;
    if (!task || TERMINAL_TASK_STATUSES.includes(task.status)) return;
    if (after.crashCount < 2) {
      setTimeout(() => void this.spawnSession(after, true).catch(() => undefined), 3000);
      await this.delivery.enqueue('worker_event', `Worker ${s.name} (${s.workerId}) on ${s.taskId} exited unexpectedly (code ${e.exitCode}); resuming it.`, { worker: s.name, worker_id: s.workerId ?? '', task: s.taskId ?? '', event: 'crashed' });
    } else {
      await this.setTaskStatus(task.id, 'failed', 'worker crashed twice');
      await this.delivery.enqueue('worker_event', `Worker ${s.name} on ${s.taskId} crashed twice; task marked failed. Re-brief and spawn again, or escalate.`, { worker: s.name, task: s.taskId ?? '', event: 'crashed_twice' });
    }
  }

  private onEvents(evs: EventEnvelope[]): void {
    this.emit('events', evs);
    this.renderBoardSoon();
    for (const e of evs) {
      if (e.type === 'attention.created' || e.type === 'attention.answered' || e.type === 'attention.withdrawn') void this.recomputeBlocked();
    }
  }

  private renderBoardSoon(): void {
    if (this.boardTimer) clearTimeout(this.boardTimer);
    this.boardTimer = setTimeout(() => {
      try {
        const tmp = this.paths.board + '.tmp';
        fs.writeFileSync(tmp, renderBoard(this.hub.state));
        fs.renameSync(tmp, this.paths.board);
      } catch {
        /* ignore */
      }
    }, 500);
  }

  private async setTaskStatus(id: string, to: TaskStatus, reason: string): Promise<void> {
    const t = this.hub.state.tasks[id];
    if (!t || t.status === to) return;
    if (!canTransition(t.status, to)) throw new ToolError('INVALID_TRANSITION', `cannot move ${id} from ${t.status} to ${to}`);
    await this.hub.commit(draft('task.status_changed', APP, { id, from: t.status, to, reason }));
  }

  private async recomputeBlocked(): Promise<void> {
    const open = Object.values(this.hub.state.attention).filter((a) => a.status === 'open' || a.status === 'snoozed');
    const blocked = new Set(open.flatMap((a) => a.blocks.tasks));
    for (const t of Object.values(this.hub.state.tasks)) {
      if (t.status === 'running' && blocked.has(t.id)) await this.setTaskStatus(t.id, 'blocked', 'waiting on user').catch(() => undefined);
      else if (t.status === 'blocked' && !blocked.has(t.id)) await this.setTaskStatus(t.id, 'running', 'unblocked').catch(() => undefined);
    }
  }

  async raiseAppItem(question: string, detail: string, worker?: string, task?: string): Promise<string> {
    const dup = Object.values(this.hub.state.attention).find((a) => a.origin === 'app' && (a.status === 'open' || a.status === 'snoozed') && a.question === question);
    if (dup) return dup.id;
    const id = this.hub.nextId('A');
    const w = worker ? this.hub.state.sessions[this.hub.state.workers[worker]] : undefined;
    await this.hub.commit(
      draft('attention.created', APP, {
        id,
        kind: 'app',
        origin: 'app',
        task,
        worker,
        workerName: w?.name,
        question,
        detail,
        options: [
          { key: 'done', label: 'Done / dismiss' },
          { key: 'retry', label: 'Retry' },
        ],
        irreversible: false,
        urgency: 'normal',
        blocks: { summary: '', workers: worker ? [worker] : [], tasks: [] },
        status: 'open',
        createdAt: new Date(this.clock.now()).toISOString(),
        snoozeCount: 0,
        deliveredCount: 0,
        alertCount: 0,
      }),
    );
    return id;
  }

  // ───────────────────────────── periodic ─────────────────────────────

  async tick(): Promise<void> {
    if (this.shuttingDown) return;
    const now = this.clock.now();
    await this.delivery.tick().catch(() => undefined);
    const u = this.usage.tick(this.hub.state, now);
    if (u.length) {
      await this.hub.commit(u);
      if (!this.hub.state.usage.paused) await this.onUsageCleared();
    }
    for (const s of Object.values(this.hub.state.sessions)) {
      if (!this.d.ptys.get(s.id)) continue;
      const last = Date.parse(s.lastActivity ?? s.stateSince ?? new Date(now).toISOString());
      const inFlight = (this.inFlightTools.get(s.id) ?? 0) > 0;
      if (s.state === 'busy' && !inFlight && now - last > STALL_MS[s.role]) {
        await this.setState(s.id, 'stalled', 'no activity');
        if (s.role === 'worker') await this.delivery.enqueue('worker_event', `Worker ${s.name} on ${s.taskId} shows no activity for ${Math.round((now - last) / 60000)} min.`, { worker: s.name, task: s.taskId ?? '', event: 'stalled' });
        else await this.raiseAppItem('The manager session appears stuck (no activity for 20 minutes).', 'Open the Manager tab.');
      }
      if (s.role === 'worker' && s.state === 'idle' && now - Date.parse(s.stateSince) > IDLE_WITHOUT_DONE_MS && !this.flaggedIdle.has(s.id)) {
        this.flaggedIdle.add(s.id);
        await this.delivery.enqueue('worker_event', `Worker ${s.name} on ${s.taskId} has been idle for 30 min without calling done.`, { worker: s.name, task: s.taskId ?? '', event: 'idle_without_done' });
      }
    }
    await this.watchdog().catch(() => undefined);
  }

  /** Defence in depth: kill notifier processes descended from any session (SPEC §8 #8). */
  private watchdog(): Promise<void> {
    const pids = new Map<number, string>();
    for (const [sid, p] of this.d.ptys.sessions) pids.set(p.pid, sid);
    if (pids.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      execFile('ps', ['-A', '-o', 'pid=,ppid=,comm='], { timeout: 4000 }, (err, stdout) => {
        if (err) return resolve();
        const rows = stdout
          .trim()
          .split('\n')
          .map((l) => l.trim().split(/\s+/, 3))
          .map(([pid, ppid, comm]) => ({ pid: Number(pid), ppid: Number(ppid), comm: path.basename(comm ?? '') }));
        const parent = new Map(rows.map((r) => [r.pid, r.ppid]));
        for (const r of rows) {
          if (!NOTIFIERS.has(r.comm)) continue;
          let p = r.ppid;
          for (let i = 0; i < 30 && p > 1; i++) {
            const sid = pids.get(p);
            if (sid) {
              try {
                process.kill(r.pid, 'SIGKILL');
              } catch {
                /* gone */
              }
              void this.hub.commit(draft('leak.detected', APP, { session: sid, kind: 'process', detail: `${r.comm} (pid ${r.pid}) killed` }));
              break;
            }
            p = parent.get(p) ?? 0;
          }
        }
        resolve();
      });
    });
  }

  // ───────────────────────────── hooks / statusline ─────────────────────────────

  onStatusline(id: Identity, body: Record<string, unknown>): void {
    const drafts = this.usage.ingest(id.session, body, this.hub.state, this.clock.now());
    this.emit('usage', id.session, this.usage.live[id.session]);
    if (drafts.length) void this.commitUsage(drafts);
  }

  private async commitUsage(drafts: DraftEvent[]): Promise<void> {
    const wasPaused = this.hub.state.usage.paused;
    await this.hub.commit(drafts);
    const st = this.hub.state.usage;
    if (!wasPaused && st.paused) {
      await this.delivery.enqueue('system', `Usage limit reached (${st.pausedSource}). New workers are paused${st.resumesAt ? ` until ${new Date(st.resumesAt * 1000).toISOString()}` : ''}. Running workers continue.`, { event: 'usage_paused' });
    } else if (wasPaused && !st.paused) {
      await this.onUsageCleared();
    }
    for (const d of drafts) {
      if (d.type === 'usage.warning') {
        const w = d.data as { pct: number; window: string };
        await this.delivery.enqueue('system', `Usage warning: ${w.window} window at ${Math.round(w.pct)}%. Start only work the user is waiting for.`, { event: 'usage_warning' });
      }
    }
  }

  private async onUsageCleared(): Promise<void> {
    await this.delivery.enqueue('system', 'Usage limit cleared; spawning resumed. Queued tasks can be spawned again.', { event: 'usage_cleared' });
    for (const s of Object.values(this.hub.state.sessions)) {
      if (s.state === 'paused_usage' && this.d.ptys.get(s.id)) {
        await this.setState(s.id, 'idle', 'usage_cleared');
        void this.d.ptys.get(s.id)!.injectPaste('Usage limits have reset. Continue your task.').catch(() => undefined);
      }
    }
  }

  onLeak(id: Identity, body: Record<string, unknown>): void {
    void this.hub.commit(draft('leak.detected', APP, { session: id.session, kind: String(body.kind ?? 'shim'), detail: String(body.detail ?? '') }));
  }

  onChannelReady(id: Identity, ready: boolean): void {
    if (ready) void this.delivery.flush();
    this.emit('channel', id.session, ready);
  }

  async onHook(id: Identity, event: string, body: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    const s = this.hub.state.sessions[id.session];
    if (!s) return undefined;
    switch (event) {
      case 'session-start':
        await this.setState(id.session, 'ready', 'hook');
        if (id.role === 'manager') void this.delivery.flush();
        return undefined;
      case 'user-prompt-submit':
        await this.setState(id.session, 'busy', 'hook');
        return undefined;
      case 'stop':
        this.inFlightTools.set(id.session, 0);
        if (s.state !== 'finished' && s.state !== 'paused_usage') await this.setState(id.session, s.state === 'waiting_on_manager' ? 'waiting_on_manager' : 'idle', 'hook');
        if (id.role === 'manager') this.delivery.managerStopped();
        return undefined;
      case 'stop-failure': {
        const text = JSON.stringify(body);
        if (/rate.?limit|usage limit|overloaded|quota/i.test(text)) {
          if (!this.hub.state.usage.paused) await this.commitUsage([draft('usage.limit_hit', APP, { source: 'hook' })]);
          if (id.role === 'worker') await this.setState(id.session, 'paused_usage', 'stop_failure');
        }
        return undefined;
      }
      case 'notification': {
        const type = String(body.notification_type ?? body.type ?? '');
        const msg = String(body.message ?? '');
        if (id.role === 'worker' && /permission/.test(type + msg) && s.state !== 'awaiting_permission') {
          await this.setState(id.session, 'awaiting_permission', 'notification');
        }
        // Worker notifications are routed to the manager, never to the OS (SPEC §8 #6).
        if (id.role === 'worker' && /idle/.test(type) && s.state !== 'finished' && s.state !== 'waiting_on_manager') {
          return undefined; // idle is tracked via Stop; the idle-without-done detector reports it
        }
        return undefined;
      }
      case 'pre-tool-use':
        return this.preToolUse(id, s, body);
      case 'post-tool-use': {
        const n = (this.inFlightTools.get(id.session) ?? 1) - 1;
        this.inFlightTools.set(id.session, Math.max(0, n));
        const tool = String(body.tool_name ?? '');
        if (tool === 'SendMessage' && id.role === 'worker') {
          const input = (body.tool_input ?? {}) as Record<string, unknown>;
          const text = String(input.message ?? input.content ?? input.text ?? '').slice(0, 200);
          await this.hub.commit(draft('message.observed', APP, { from: id.name, to: MANAGER_NAME, summary: text }));
          await this.setState(id.session, 'waiting_on_manager', 'sendmessage');
        } else if (s.state === 'awaiting_permission') {
          await this.setState(id.session, 'busy', 'post_tool');
        }
        return undefined;
      }
      case 'permission-request':
        return this.permissionRequest(id, s, body);
      case 'session-end':
        return undefined;
      default:
        return undefined;
    }
  }

  private writableRoots(s: Session): string[] {
    const roots = [s.cwd, path.join(this.paths.tasks, s.taskId ?? '__none__')];
    return roots;
  }

  private async preToolUse(id: Identity, s: Session, body: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    this.inFlightTools.set(id.session, (this.inFlightTools.get(id.session) ?? 0) + 1);
    const tool = String(body.tool_name ?? '');
    const input = (body.tool_input ?? {}) as Record<string, unknown>;
    const grants = Object.values(this.hub.state.grants).filter((g) => !g.consumed && g.task === s.taskId);
    const r = evaluateFloor(tool, input, {
      role: id.role,
      cwd: String(body.cwd ?? s.cwd),
      writableRoots: this.writableRoots(s),
      grants,
      managerName: MANAGER_NAME,
    });
    if (s.state === 'waiting_on_manager' || s.state === 'idle' || s.state === 'ready') await this.setState(id.session, 'busy', 'tool');
    if (r.decision === 'none') {
      if (r.note?.startsWith('sendmessage_target_unknown')) await this.hub.commit(draft('leak.detected', APP, { session: id.session, kind: 'sendmessage_unverified', detail: r.note }));
      return undefined;
    }
    if (r.decision === 'allow') {
      await this.hub.commit(draft('grant.consumed', APP, { id: r.grantId }));
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: r.reason } };
    }
    if (r.category === 'notify') await this.hub.commit(draft('leak.detected', APP, { session: id.session, kind: 'blocked_' + r.category, detail: `${tool}: ${JSON.stringify(input).slice(0, 200)}` }));
    this.inFlightTools.set(id.session, Math.max(0, (this.inFlightTools.get(id.session) ?? 1) - 1));
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.reason } };
  }

  private async permissionRequest(id: Identity, s: Session, body: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    const tool = String(body.tool_name ?? '');
    const input = (body.tool_input ?? {}) as Record<string, unknown>;
    const summary = `${tool} ${JSON.stringify(input).slice(0, 300)}`;
    const task = s.taskId ? this.hub.state.tasks[s.taskId] : undefined;
    const out = (behavior: 'allow' | 'deny', message?: string) => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior, ...(message ? { message } : {}) } } });
    if (task?.autoAllow.some((rule) => ruleMatches(rule, tool, input))) return out('allow');
    await this.setState(id.session, 'awaiting_permission', 'permission_request');
    const pid = this.hub.nextId('P');
    await this.hub.commit(draft('permission.requested', APP, { id: pid, session: s.id, worker: s.workerId, task: s.taskId, tool, inputSummary: summary }));
    if (id.role === 'manager') {
      await this.raiseAppItem(`The manager wants to use ${tool} and Claude Code is asking for permission.`, summary.slice(0, 500));
      await this.hub.commit(draft('permission.decided', APP, { id: pid, decision: 'deny', by: 'app' }));
      return out('deny', 'Permission prompts for the manager go to the user; this was denied for now. Use read-only tools or delegate to a worker.');
    }
    await this.delivery.enqueue('permission_request', `Worker ${s.name} (${s.taskId}) asks to run: ${summary}\nDecide with decide_permission(request_id="${pid}").`, { request: pid, worker: s.name, task: s.taskId ?? '' });
    const decision = await new Promise<{ decision: 'allow' | 'deny'; message?: string } | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.permissionWaiters.delete(pid);
        resolve(undefined);
      }, PERMISSION_HOLD_MS);
      this.permissionWaiters.set(pid, (d) => {
        clearTimeout(timer);
        resolve(d);
      });
    });
    if (!decision) {
      await this.hub.commit(draft('permission.decided', APP, { id: pid, decision: 'expired', by: 'timeout' }));
      return out('deny', `Waiting for your manager to decide (${pid}). Ask @manager with SendMessage if needed and continue with other work.`);
    }
    return out(decision.decision, decision.message);
  }

  // ───────────────────────────── tools ─────────────────────────────

  async callTool(id: Identity, name: ToolName, args: Record<string, unknown>): Promise<unknown> {
    const ackIds = (args.ack as string[] | undefined) ?? [];
    const result = await this.dispatch(id, name, args);
    if (ackIds.length && id.role === 'manager') await this.delivery.ack(ackIds);
    return result;
  }

  private worker(ref: string): Session {
    const st = this.hub.state;
    const byId = st.workers[ref] ? st.sessions[st.workers[ref]] : undefined;
    const s = byId ?? Object.values(st.sessions).find((x) => x.role === 'worker' && x.name === ref.replace(/^@/, '') && !x.cleanedUp);
    if (!s) throw new ToolError('NOT_FOUND', `no worker "${ref}"`);
    return s;
  }

  private task(id: string): Task {
    const t = this.hub.state.tasks[id];
    if (!t) throw new ToolError('NOT_FOUND', `no task ${id}`);
    return t;
  }

  private verifyQuote(quote: string): boolean {
    const mgr = this.liveManager();
    const lines = mgr ? this.d.ptys.get(mgr.id)?.userLines ?? [] : [];
    const norm = (x: string) => x.replace(/\s+/g, ' ').trim().toLowerCase();
    const q = norm(quote);
    return q.length > 0 && lines.some((l) => norm(l).includes(q));
  }

  private async dispatch(id: Identity, name: ToolName, a: Record<string, any>): Promise<unknown> {
    const st = this.hub.state;
    const actor = { role: id.role, id: id.name } as const;
    const now = () => new Date(this.clock.now()).toISOString();
    if (id.role === 'worker') {
      const s = st.sessions[id.session];
      const taskId = id.task!;
      switch (name) {
        case 'report_progress':
          await this.hub.commit(draft('progress.reported', actor, { task: taskId, worker: id.worker!, summary: a.summary, percent: a.percent }));
          return { ok: true };
        case 'request_approval': {
          const rid = this.hub.nextId('R');
          await this.hub.commit(draft('approval.requested', actor, { id: rid, task: taskId, worker: id.worker!, actionKind: a.action_kind, summary: a.summary, exactCommandOrTool: a.exact_command_or_tool, why: a.why, createdAt: now() }));
          await this.delivery.enqueue(
            'approval_request',
            `Worker ${id.name} (${taskId}) requests approval ${rid}: ${a.summary}\nAction: ${a.action_kind} — ${a.exact_command_or_tool}\nWhy: ${a.why}${a.reversible_alternative ? `\nReversible alternative: ${a.reversible_alternative}` : ''}`,
            { ticket: rid, worker: id.name, task: taskId },
          );
          return { ticket_id: rid, status: 'queued', guidance: 'Continue with other parts of the task. Your manager will message you with the outcome.' };
        }
        case 'done': {
          const t = this.task(taskId);
          let branch: string | undefined = a.branch ?? t.branch;
          let ahead = 0;
          if (t.kind === 'code' && t.branch && fs.existsSync(s.cwd)) {
            if (!(await gitsvc.isClean(s.cwd))) throw new ToolError('UNCOMMITTED_CHANGES', 'commit your changes (git add + git commit) before calling done');
            ahead = await gitsvc.commitsAhead(s.cwd, t.baseBranch ?? 'HEAD');
            if (ahead === 0) branch = undefined;
          }
          await this.hub.commit(draft('task.completed', actor, { id: taskId, outcome: a.outcome, summary: a.summary_md, artifacts: a.artifacts ?? [], branch, verification: a.verification }));
          const to: TaskStatus = a.outcome === 'failed' ? 'failed' : branch ? 'review' : 'done';
          await this.setTaskStatus(taskId, to, 'worker done');
          await this.setState(id.session, 'finished', 'done');
          const diff = branch && t.baseBranch ? await gitsvc.diffStat(s.cwd, t.baseBranch).catch(() => '') : '';
          await this.delivery.enqueue(
            'worker_done',
            `Worker ${id.name} finished ${taskId} (${a.outcome}).\n${a.summary_md}\nVerification: ${a.verification}${branch ? `\nBranch ${branch} (${ahead} commit(s) ahead of ${t.baseBranch}).\n${diff}` : ''}${a.follow_ups?.length ? `\nFollow-ups: ${a.follow_ups.join('; ')}` : ''}`,
            { worker: id.name, task: taskId },
          );
          return { ok: true, next: 'stop and wait; your manager may send follow-up instructions' };
        }
        case 'ask_manager':
        case 'report_to_manager':
          if (!this.d.fallbackB) throw new ToolError('UNAUTHORIZED_ROLE', 'use SendMessage to @manager');
          await this.delivery.enqueue('worker_event', `Message from worker ${id.name} (${taskId}): ${a.question ?? a.text}`, { worker: id.name, task: taskId, event: 'message' });
          return { status: 'queued' };
        default:
          throw new ToolError('UNAUTHORIZED_ROLE', `${name} is not available to workers`);
      }
    }

    switch (name) {
      case 'create_task': {
        if (a.pre_authorized?.length && !a.pre_authorized.every((p: { quote: string }) => this.verifyQuote(p.quote)))
          throw new ToolError('PREAUTH_NOT_VERIFIED', 'pre_authorized quotes must be words the user typed in the manager chat');
        const tid = this.hub.nextId('T');
        await this.hub.commit(
          draft('task.created', actor, {
            id: tid,
            title: a.title,
            description: a.description,
            kind: a.kind,
            repo: a.repo ? this.repoConfig(a.repo)?.path ?? a.repo : undefined,
            baseBranch: a.base_branch,
            priority: a.priority ?? 3,
            escalation: a.escalation ?? { preset: 'default' },
            preAuthorized: a.pre_authorized ?? [],
            skillsHint: a.skills_hint ?? [],
            dependsOn: a.depends_on ?? [],
            mcpServers: a.mcp_servers ?? [],
            source: 'chat',
          }),
        );
        await this.setTaskStatus(tid, 'planned', 'created by manager');
        return { task_id: tid };
      }
      case 'update_task': {
        const t = this.task(a.task_id);
        const p = a.patch ?? {};
        if (p.pre_authorized && !p.pre_authorized.every((x: { quote: string }) => this.verifyQuote(x.quote))) throw new ToolError('PREAUTH_NOT_VERIFIED', 'quotes must be the user’s typed words');
        const patch: Record<string, unknown> = {};
        for (const [k, v] of Object.entries({ title: p.title, description: p.description, priority: p.priority, escalation: p.escalation, notes: p.notes, skillsHint: p.skills_hint, autoAllow: p.auto_allow, dependsOn: p.depends_on, kind: p.kind, repo: p.repo, baseBranch: p.base_branch, preAuthorized: p.pre_authorized }))
          if (v !== undefined) patch[k] = v;
        if (Object.keys(patch).length) await this.hub.commit(draft('task.updated', actor, { id: t.id, patch }));
        if (p.status) {
          await this.setTaskStatus(t.id, p.status, 'manager');
          if (p.status === 'cancelled') await this.cancelTaskEffects(t.id);
        }
        await this.delivery.ackWhere('task', t.id).catch(() => undefined);
        return { task: this.hub.state.tasks[t.id] };
      }
      case 'list_tasks': {
        let ts = Object.values(st.tasks);
        if (a.status?.length) ts = ts.filter((t) => a.status.includes(t.status));
        return {
          tasks: ts.slice(-(a.limit ?? 100)).map((t) => ({
            id: t.id, title: t.title, status: t.status, kind: t.kind, priority: t.priority,
            worker: t.worker ? st.sessions[st.workers[t.worker]]?.name : undefined, updated_at: t.updatedAt, escalation_preset: t.escalation.preset,
          })),
        };
      }
      case 'get_task': {
        const t = this.task(a.task_id);
        const sess = t.worker ? st.sessions[st.workers[t.worker]] : undefined;
        const u = sess ? st.usage.perSession[sess.id] : undefined;
        return { ...t, worker_name: sess?.name, usage: u ? { est_cost_usd: totalCost(u), tokens: totalTokens(u), ctx_pct: u.ctxUsedPct } : undefined };
      }
      case 'spawn_worker':
        return this.spawnWorker(a);
      case 'stop_worker': {
        const s = this.worker(a.worker);
        await this.stopSession(s.id, a.mode === 'force');
        return { status: 'stopping', worker: s.name };
      }
      case 'list_workers': {
        return Object.values(st.sessions)
          .filter((s) => s.role === 'worker' && (a.include_finished || LIVE_SESSION_STATES.includes(s.state)) && !s.cleanedUp)
          .map((s) => {
            const u = st.usage.perSession[s.id];
            return { worker_id: s.workerId, name: s.name, task_id: s.taskId, state: s.state, cwd: s.cwd, last_activity: s.lastActivity, ctx_pct: u?.ctxUsedPct, est_cost_usd: totalCost(u), live: !!this.d.ptys.get(s.id) };
          });
      }
      case 'get_worker_output': {
        const s = this.worker(a.worker);
        const p = this.d.ptys.get(s.id);
        return { text: p ? p.tail(a.lines ?? 100) : '(session not live)' };
      }
      case 'decide_permission': {
        const p = st.permissions[a.request_id];
        if (!p) throw new ToolError('NOT_FOUND', `no permission request ${a.request_id}`);
        const w = this.permissionWaiters.get(a.request_id);
        await this.hub.commit(draft('permission.decided', actor, { id: p.id, decision: a.decision, by: 'manager' }));
        if (a.remember && a.decision === 'allow' && p.task) {
          const t = this.task(p.task);
          if (a.remember.scope === 'task') await this.hub.commit(draft('task.updated', actor, { id: t.id, patch: { autoAllow: [...t.autoAllow, a.remember.pattern] } }));
        }
        await this.delivery.ackWhere('request', p.id);
        if (w) {
          this.permissionWaiters.delete(a.request_id);
          w({ decision: a.decision, message: a.message });
          return { ok: true };
        }
        if (p.status === 'expired' && a.decision === 'allow' && p.task) {
          const tool = p.inputSummary.split(' ')[0];
          const gid = this.hub.nextId('G');
          await this.hub.commit(draft('grant.created', actor, { id: gid, task: p.task, worker: p.worker, pattern: tool, scope: 'once', source: p.id }));
          return { ok: true, note: `The worker's request had already timed out. A one-shot grant ${gid} for ${tool} was created; tell the worker with SendMessage that it may retry.` };
        }
        return { ok: true };
      }
      case 'decide_approval': {
        const r = st.approvals[a.ticket];
        if (!r) throw new ToolError('NOT_FOUND', `no approval ticket ${a.ticket}`);
        if (r.status !== 'pending') throw new ToolError('INVALID_TRANSITION', `ticket ${r.id} is ${r.status}`);
        const probe = evaluateFloor(r.exactCommandOrTool.startsWith('mcp__') ? r.exactCommandOrTool : 'Bash', { command: r.exactCommandOrTool }, { role: 'worker', cwd: '/', writableRoots: [], grants: [] });
        if (a.decision === 'granted' && (probe.decision === 'deny' || ['git.push', 'git.merge', 'deploy', 'send_message', 'spend', 'delete'].includes(r.actionKind)))
          throw new ToolError('IRREVERSIBLE_NEEDS_USER', 'this action is irreversible: use escalate(kind="approval", ticket=…)');
        await this.hub.commit(draft('approval.decided', actor, { id: r.id, decision: a.decision, message: a.message }));
        if (a.decision === 'granted') {
          const gid = this.hub.nextId('G');
          await this.hub.commit(draft('grant.created', actor, { id: gid, task: r.task, worker: r.worker, pattern: r.exactCommandOrTool.startsWith('mcp__') ? r.exactCommandOrTool : `Bash(${r.exactCommandOrTool})`, scope: 'once', source: r.id }));
        }
        await this.delivery.ackWhere('ticket', r.id);
        return { ok: true, next: `Tell ${st.sessions[st.workers[r.worker]]?.name ?? r.worker} the outcome with SendMessage.` };
      }
      case 'escalate':
        return this.escalate(id, a);
      case 'list_attention': {
        let items = Object.values(st.attention);
        if (a.status?.length) items = items.filter((x) => a.status.includes(x.status));
        else items = items.filter((x) => x.status !== 'applied' && x.status !== 'withdrawn');
        return items;
      }
      case 'ack_attention': {
        const it = st.attention[a.attention_id];
        if (!it) throw new ToolError('NOT_FOUND', `no item ${a.attention_id}`);
        if (it.status !== 'answered') throw new ToolError('NOT_ANSWERED', `${it.id} is ${it.status}; only answered items can be acknowledged`);
        await this.hub.commit(draft('attention.applied', actor, { id: it.id, actionTaken: a.action_taken }));
        await this.delivery.ackWhere('attention', it.id);
        return { status: 'applied' };
      }
      case 'record_chat_answer': {
        const it = st.attention[a.attention_id];
        if (!it || (it.status !== 'open' && it.status !== 'snoozed')) throw new ToolError('NOT_FOUND', `no open item ${a.attention_id}`);
        if (!this.verifyQuote(a.quote)) throw new ToolError('QUOTE_NOT_VERIFIED', 'the quote does not match anything the user typed in the manager tab');
        if (a.option_key && !it.options.some((o) => o.key === a.option_key)) throw new ToolError('INVALID_ARGUMENT', `unknown option ${a.option_key}`);
        await this.hub.commit(draft('attention.answered', USER, { id: it.id, answer: { optionKey: a.option_key, text: a.text, via: 'chat_quote', quote: a.quote, at: now() } }));
        await this.afterAnswer([it.id], false);
        return { status: 'answered' };
      }
      case 'execute_approved':
        return this.executeApproved(a);
      case 'report_to_user': {
        this.task(a.task_id);
        const rid = this.hub.nextId('RP');
        await this.hub.commit(draft('report.created', actor, { id: rid, task: a.task_id, kind: a.kind, summary: a.summary_md }));
        return { report_id: rid };
      }
      case 'list_skills': {
        const skills = scanSkills(this.knownRepos());
        const q = (a.query ?? '').toLowerCase();
        return skills
          .filter((s) => !q || s.name.includes(q) || s.description.toLowerCase().includes(q))
          .map((s) => ({ name: s.name, description: s.description, when_to_use: s.whenToUse, scope: s.scope, path: s.path, repo: s.repo }));
      }
      case 'get_skill': {
        const sk = scanSkills(this.knownRepos()).find((s) => s.name === a.name);
        if (!sk) throw new ToolError('NOT_FOUND', `no skill ${a.name}`);
        const text = fs.readFileSync(sk.path, 'utf8');
        const { fm, body } = parseFrontmatter(text);
        return { frontmatter: fm, body, files: fs.readdirSync(path.dirname(sk.path)) };
      }
      case 'write_skill': {
        let dir = path.join(process.env.HOME ?? '', '.claude', 'skills');
        if (a.scope === 'project') {
          const t = this.task(a.task_id ?? '');
          const s = t.worker ? st.sessions[st.workers[t.worker]] : undefined;
          if (!s) throw new ToolError('INVALID_ARGUMENT', 'project skills need task_id of a task with a worktree');
          dir = path.join(s.cwd, '.claude', 'skills');
        }
        try {
          const r = writeSkill({ dir, name: a.name, description: a.description, body: a.body_md, update: a.update, backupRoot: this.paths.skillBackups });
          await this.hub.commit(draft('skill.created', actor, { name: a.name, path: r.path, scope: a.scope ?? 'user', backup: r.backup, update: !!r.backup }));
          return { path: r.path, backup: r.backup };
        } catch (e) {
          throw new ToolError((e as { code?: string }).code ?? 'INVALID_ARGUMENT', (e as Error).message);
        }
      }
      case 'usage_status': {
        const u = st.usage;
        return {
          paused: u.paused,
          resumes_at: u.resumesAt,
          plan: u.plan,
          thresholds: { warn_pct: st.config.usageWarnPct, pause_pct: st.config.usagePausePct },
          sessions: Object.values(st.sessions)
            .filter((s) => this.d.ptys.get(s.id))
            .map((s) => ({ name: s.name, role: s.role, ctx_pct: (this.usage.live[s.id] ?? u.perSession[s.id])?.ctxUsedPct, est_cost_usd: totalCost(this.usage.live[s.id] ?? u.perSession[s.id]) })),
        };
      }
      case 'ack_event':
        await this.delivery.ack(a.event_ids ?? []);
        return { ok: true };
      default:
        throw new ToolError('UNAUTHORIZED_ROLE', `${name} is not available to the manager`);
    }
  }

  private knownRepos(): string[] {
    const set = new Set<string>();
    for (const t of Object.values(this.hub.state.tasks)) if (t.repo) set.add(t.repo);
    try {
      const all = JSON.parse(fs.readFileSync(this.paths.repos, 'utf8')) as { repos?: Record<string, RepoConfig> };
      for (const r of Object.values(all.repos ?? {})) set.add(r.path);
    } catch {
      /* none */
    }
    return [...set];
  }

  private async spawnWorker(a: Record<string, any>): Promise<unknown> {
    const st = this.hub.state;
    const t = this.task(a.task_id);
    if (TERMINAL_TASK_STATUSES.includes(t.status)) throw new ToolError('TASK_NOT_ASSIGNABLE', `${t.id} is ${t.status}`);
    if (t.worker) {
      const cur = st.sessions[st.workers[t.worker]];
      if (cur && this.d.ptys.get(cur.id)) throw new ToolError('TASK_NOT_ASSIGNABLE', `${t.id} already has live worker ${cur.name}`);
    }
    const waiting = t.dependsOn.filter((dep) => st.tasks[dep]?.status !== 'done');
    if (waiting.length) throw new ToolError('TASK_NOT_ASSIGNABLE', `${t.id} depends on unfinished tasks`, { waiting_on: waiting });
    if (st.usage.paused) {
      if (t.status !== 'queued' && canTransition(t.status, 'queued')) await this.setTaskStatus(t.id, 'queued', 'usage paused');
      throw new ToolError('USAGE_PAUSED', 'usage limits reached; spawning is paused', { resumes_at: st.usage.resumesAt });
    }
    const missingSkills = (a.skills ?? []).filter((n: string) => !scanSkills(this.knownRepos()).some((s) => s.name === n));
    if (missingSkills.length) throw new ToolError('SKILL_NOT_FOUND', `unknown skills: ${missingSkills.join(', ')}`, { names: missingSkills });
    const taken = new Set(Object.values(st.sessions).filter((s) => !s.cleanedUp).map((s) => s.name));
    const nm = assignName(a.name, t.title, taken);
    if (nm.error) throw new ToolError('INVALID_ARGUMENT', nm.error);
    const workerId = this.hub.nextId('W');
    const slug = nm.name;
    let cwd: string;
    let branch: string | undefined;
    let workspace: string | undefined;
    let base = t.baseBranch;
    if (t.kind === 'code' || (t.repo && t.kind === 'mixed')) {
      if (!t.repo) throw new ToolError('REPO_NOT_FOUND', `${t.id} is a code task without a repo`);
      const repo = await gitsvc.repoRoot(t.repo).catch(() => {
        throw new ToolError('REPO_NOT_FOUND', `${t.repo} is not a git repository`);
      });
      base = base ?? this.repoConfig(repo)?.base_branch ?? (await gitsvc.defaultBranch(repo));
      branch = `agentboard/${t.id}-${slug}`;
      cwd = path.join(this.paths.worktrees, path.basename(repo), `${t.id}-${slug}`);
      try {
        await gitsvc.addWorktree(repo, cwd, branch, base);
      } catch (e) {
        throw new ToolError('WORKTREE_FAILED', (e as Error).message, { git_stderr: (e as gitsvc.GitError).stderr });
      }
      for (const f of this.repoConfig(repo)?.copy_files ?? []) {
        const src = path.join(repo, f);
        if (fs.existsSync(src)) fs.cpSync(src, path.join(cwd, f), { recursive: true });
      }
      if (!t.baseBranch || t.repo !== repo) await this.hub.commit(draft('task.updated', APP, { id: t.id, patch: { baseBranch: base, repo } }));
    } else {
      cwd = path.join(this.paths.workspaces, `${t.id}-${slug}`);
      fs.mkdirSync(path.join(cwd, 'inputs'), { recursive: true });
      fs.mkdirSync(path.join(cwd, 'outputs'), { recursive: true });
      workspace = cwd;
    }
    const taskDir = path.join(this.paths.tasks, t.id);
    fs.mkdirSync(taskDir, { recursive: true });
    const briefPath = path.join(taskDir, 'brief.md');
    const footer = [
      '',
      '---',
      '## agentboard details (appended automatically)',
      `- Task: ${t.id} · Your worker id: ${workerId} · **Your session name: \`${nm.name}\`** · Your manager: \`manager\``,
      `- Work only inside: ${cwd}${branch ? ` (branch \`${branch}\`, base \`${base}\`)` : ''}`,
      `- Task notes directory: ${taskDir}`,
      `- Skills to use (Skill tool): ${(a.skills ?? []).map((s: string) => `\`${s}\``).join(', ') || 'none named'}`,
      '- agentboard tools: `mcp__agentboard__report_progress`, `mcp__agentboard__request_approval`, `mcp__agentboard__done`',
      '- Questions: SendMessage to `@manager`, prefixed `Q<n>:`. Never contact anyone else.',
      `- Pre-authorised for this task: ${t.preAuthorized.length ? t.preAuthorized.map((p) => `${p.action} (${p.scope})`).join('; ') : 'nothing'} (agentboard performs merges/pushes itself)`,
    ].join('\n');
    fs.writeFileSync(briefPath, `${a.brief_markdown.trim()}\n${footer}\n`);
    const session: Session = { id: randomUUID(), role: 'worker', name: nm.name, workerId, taskId: t.id, cwd, state: 'spawning', stateSince: '', crashCount: 0, cleanedUp: false, resumeCount: 0 };
    await this.hub.commit(draft('task.assigned', APP, { id: t.id, worker: workerId, branch, workspace }));
    const startPrompt = `Read ${briefPath} and carry out the task end to end. Follow the escalation rules in it. Use the agentboard tools (report_progress, request_approval, done) and SendMessage to @manager for questions.`;
    void (async () => {
      try {
        const pty = await this.spawnSession(session, false, { startPrompt, model: a.model, addDirs: a.add_dirs, mcpServers: a.mcp_servers, extraAllow: a.extra_allow });
        await this.waitReady(session.id, pty);
        if (canTransition(this.hub.state.tasks[t.id].status, 'running')) await this.setTaskStatus(t.id, 'running', 'worker spawned');
        await this.hub.commit(draft('worker.spawned', APP, { worker: workerId, session: session.id, name: nm.name, task: t.id }));
        await this.delivery.enqueue('worker_spawned', `Worker ${nm.name} (${workerId}) started on ${t.id} in ${cwd}.`, { worker: nm.name, worker_id: workerId, task: t.id });
      } catch (e) {
        await this.hub.commit(draft('worker.spawn_failed', APP, { worker: workerId, session: session.id, task: t.id, error: String((e as Error).message ?? e) }));
        await this.delivery.enqueue('spawn_failed', `Spawning ${nm.name} for ${t.id} failed: ${String((e as Error).message ?? e)}`, { worker: nm.name, task: t.id });
      }
    })();
    return { worker_id: workerId, name: nm.name, session_id: session.id, status: 'spawning', cwd, branch, brief_path: briefPath };
  }

  private waitReady(session: string, pty: PtySession): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const s = this.hub.state.sessions[session];
        if (s && ['ready', 'idle', 'busy', 'waiting_on_manager', 'awaiting_permission'].includes(s.state)) {
          cleanup();
          resolve();
        } else if (s && s.state === 'needs_user_dialog') {
          cleanup();
          resolve(); // spawned; user must finish a dialog (attention item raised)
        }
      };
      const onExit = () => {
        cleanup();
        reject(new Error('claude exited during startup'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('timed out waiting for the session to become ready'));
      }, READY_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        this.hub.off('events', check);
        pty.off('exit', onExit);
      };
      this.hub.on('events', check);
      pty.on('exit', onExit);
      check();
    });
  }

  async stopSession(session: string, force = false): Promise<void> {
    const p = this.d.ptys.get(session);
    this.stopping.add(session);
    if (!p) return;
    await this.setState(session, 'exiting', 'stop').catch(() => undefined);
    if (force) {
      p.kill('SIGKILL');
      return;
    }
    await p.sendKeys(['\x1b'], 1000);
    await p.sendKeys(['\x03', '\x03'], 500);
    setTimeout(() => {
      if (!p.exited) p.kill('SIGTERM');
    }, 20_000);
    setTimeout(() => {
      if (!p.exited) p.kill('SIGKILL');
    }, 60_000);
  }

  private async escalate(id: Identity, a: Record<string, any>): Promise<unknown> {
    const st = this.hub.state;
    const t = this.task(a.task_id);
    const w = a.worker ? this.worker(a.worker) : t.worker ? st.sessions[st.workers[t.worker]] : undefined;
    const options = (a.options as AttentionItem['options'] | undefined) ?? [
      { key: 'yes', label: 'Yes' },
      { key: 'no', label: 'No' },
    ];
    const norm = (x: string) => x.replace(/\s+/g, ' ').trim().toLowerCase();
    const dup = Object.values(st.attention).find((x) => (x.status === 'open' || x.status === 'snoozed') && x.task === t.id && x.kind === a.kind && norm(x.question) === norm(a.question));
    if (dup) throw new ToolError('DUPLICATE_OPEN_ITEM', `already open as ${dup.id}`, { existing: dup.id });
    if (a.recommendation && !options.some((o) => o.key === a.recommendation.option_key)) throw new ToolError('INVALID_ARGUMENT', 'recommendation.option_key must be one of the option keys');
    if (a.ticket) {
      const r = st.approvals[a.ticket];
      if (!r) throw new ToolError('NOT_FOUND', `no approval ticket ${a.ticket}`);
    }
    const aid = this.hub.nextId('A');
    const workers = (a.blocks?.workers as string[] | undefined)?.map((x) => this.worker(x).workerId!) ?? (w?.workerId ? [w.workerId] : []);
    const item: AttentionItem = {
      id: aid,
      kind: a.kind,
      origin: 'manager',
      task: t.id,
      worker: w?.workerId,
      workerName: w?.name,
      ticket: a.ticket,
      question: a.question,
      detail: a.detail_md,
      options,
      recommendation: a.recommendation ? { optionKey: a.recommendation.option_key, rationale: a.recommendation.rationale } : undefined,
      irreversible: !!a.irreversible,
      urgency: a.urgency ?? 'normal',
      blocks: { summary: a.blocks?.summary ?? '', workers, tasks: a.blocks?.tasks ?? [t.id] },
      status: 'open',
      createdAt: new Date(this.clock.now()).toISOString(),
      snoozeCount: 0,
      deliveredCount: 0,
      alertCount: 0,
    };
    await this.hub.commit(draft('attention.created', { role: 'manager', id: id.name }, item));
    if (a.ticket) await this.hub.commit(draft('approval.decided', { role: 'manager', id: id.name }, { id: a.ticket, decision: 'escalated', attention: aid }));
    if (a.ticket) await this.delivery.ackWhere('ticket', a.ticket);
    return { attention_id: aid };
  }

  private async executeApproved(a: Record<string, any>): Promise<unknown> {
    const st = this.hub.state;
    let task: Task;
    let source: { kind: 'attention'; id: string } | { kind: 'preauth'; index: number };
    if (a.attention_id) {
      const it = st.attention[a.attention_id];
      if (!it) throw new ToolError('NOT_FOUND', `no item ${a.attention_id}`);
      if (it.status !== 'answered' && it.status !== 'applied') throw new ToolError('NOT_APPROVED', `${it.id} has not been answered by the user`);
      if (it.executed) throw new ToolError('ALREADY_EXECUTED', `${it.id} was already executed`);
      const opt = it.options.find((o) => o.key === it.answer?.optionKey);
      if (!opt?.action || opt.action !== a.action) throw new ToolError('APPROVAL_MISMATCH', `the user chose "${opt?.label ?? it.answer?.text}", which does not authorise ${a.action}`);
      task = this.task(it.task!);
      source = { kind: 'attention', id: it.id };
    } else {
      task = this.task(a.task_id);
      const pa = task.preAuthorized[a.preauth_index ?? -1];
      if (!pa) throw new ToolError('NOT_APPROVED', 'no such pre-authorisation');
      if (pa.executed) throw new ToolError('ALREADY_EXECUTED', 'pre-authorisation already used');
      const ok = pa.action === a.action || (pa.action === 'git.push' && a.action === 'git.push_branch');
      if (!ok) throw new ToolError('APPROVAL_MISMATCH', `pre-authorisation covers ${pa.action}, not ${a.action}`);
      source = { kind: 'preauth', index: a.preauth_index };
    }
    if (!task.repo || !task.branch) {
      if (a.action !== 'worktree.cleanup') throw new ToolError('INVALID_ARGUMENT', `${task.id} has no repo/branch`);
    }
    const sess = task.worker ? st.sessions[st.workers[task.worker]] : undefined;
    let ok = true;
    let output = '';
    try {
      if (a.action === 'git.merge') {
        const r = await gitsvc.mergeIntoBase(task.repo!, task.baseBranch ?? (await gitsvc.defaultBranch(task.repo!)), task.branch!, `Merge ${task.branch} (${task.id}: ${task.title})`);
        output = `merged as ${r.commit}`;
      } else if (a.action === 'git.push') {
        output = await gitsvc.pushBranch(task.repo!, task.baseBranch ?? (await gitsvc.defaultBranch(task.repo!)));
      } else if (a.action === 'git.push_branch') {
        output = await gitsvc.pushBranch(task.repo!, task.branch!);
      } else if (a.action === 'worktree.cleanup') {
        output = await this.cleanupWorktree(task, sess);
      }
    } catch (e) {
      ok = false;
      const ge = e as gitsvc.GitError;
      output = ge.message;
      const evt = source.kind === 'attention' ? draft('attention.executed', APP, { id: source.id, action: a.action, ok, output }) : draft('preauth.executed', APP, { task: task.id, index: source.index, action: a.action, ok, output });
      await this.hub.commit(evt);
      if (ge.code === 'CONFLICT') throw new ToolError('CONFLICT', ge.message, { files: ge.files });
      if (ge.code === 'DIRTY') throw new ToolError('GIT_FAILED', ge.message);
      throw new ToolError('GIT_FAILED', ge.message, { stderr: ge.stderr });
    }
    const evt = source.kind === 'attention' ? draft('attention.executed', APP, { id: source.id, action: a.action, ok, output }) : draft('preauth.executed', APP, { task: task.id, index: source.index, action: a.action, ok, output });
    await this.hub.commit(evt);
    if (a.action === 'git.merge' && task.status === 'review') {
      await this.setTaskStatus(task.id, 'done', 'merged');
      await this.cleanupWorktree(this.hub.state.tasks[task.id], sess).catch(() => undefined);
    }
    return { ok, output };
  }

  private async cleanupWorktree(task: Task, sess: Session | undefined): Promise<string> {
    if (!sess || sess.cleanedUp) return 'nothing to clean';
    if (this.d.ptys.get(sess.id)) await this.stopSession(sess.id);
    let removed = false;
    let branchDeleted = false;
    if (task.repo && task.branch && fs.existsSync(sess.cwd)) {
      if (!(await gitsvc.isClean(sess.cwd))) return 'worktree has uncommitted changes; kept';
      await gitsvc.removeWorktree(task.repo, sess.cwd);
      removed = true;
      if (task.status === 'done') {
        await gitsvc.deleteBranch(task.repo, task.branch);
        branchDeleted = true;
      }
    }
    await this.hub.commit(draft('session.cleaned_up', APP, { session: sess.id, worktreeRemoved: removed, branchDeleted }));
    return `worktree ${removed ? 'removed' : 'kept'}${branchDeleted ? ', branch deleted' : ''}`;
  }

  private async cancelTaskEffects(taskId: string): Promise<void> {
    const st = this.hub.state;
    const t = st.tasks[taskId];
    for (const it of Object.values(st.attention)) {
      if (it.task === taskId && (it.status === 'open' || it.status === 'snoozed')) await this.hub.commit(draft('attention.withdrawn', APP, { id: it.id, reason: 'task_cancelled' }));
    }
    const sess = t?.worker ? st.sessions[st.workers[t.worker]] : undefined;
    if (sess && this.d.ptys.get(sess.id)) await this.stopSession(sess.id);
  }

  // ───────────────────────────── user commands (IPC) ─────────────────────────────

  async userAddTask(input: { title: string; description?: string; kind?: Task['kind']; repo?: string; priority?: number; escalation?: Task['escalation']; preAuthorized?: Task['preAuthorized'] }): Promise<string> {
    const tid = this.hub.nextId('T');
    await this.hub.commit(
      draft('task.created', USER, {
        id: tid,
        title: input.title.slice(0, 200),
        description: input.description ?? input.title,
        kind: input.kind ?? (input.repo ? 'code' : 'mixed'),
        repo: input.repo,
        priority: input.priority ?? 3,
        escalation: input.escalation ?? { preset: 'default' },
        preAuthorized: input.preAuthorized ?? [],
        skillsHint: [],
        dependsOn: [],
        mcpServers: [],
        source: 'board',
      }),
    );
    const t = this.hub.state.tasks[tid];
    await this.delivery.enqueue(
      'new_task',
      `New task ${tid} from the user: ${t.title}\n${t.description !== t.title ? t.description + '\n' : ''}Kind: ${t.kind}${t.repo ? ` · Repo: ${t.repo}` : ''} · Priority: ${t.priority} · Escalation: ${t.escalation.preset}${t.escalation.text ? ` — "${t.escalation.text}"` : ''}${t.preAuthorized.length ? ` · Pre-authorised: ${t.preAuthorized.map((p) => p.action).join(', ')}` : ''}`,
      { task: tid },
    );
    return tid;
  }

  previewBatch(input: string) {
    return parseBatch(input, this.hub.state.attention, new Date(this.clock.now()));
  }

  async userAnswerBatch(input: string): Promise<{ ok: boolean; errors: string[]; answered: string[]; snoozed: string[] }> {
    const r = parseBatch(input, this.hub.state.attention, new Date(this.clock.now()));
    if (!r.ok) return { ok: false, errors: r.errors, answered: [], snoozed: [] };
    const now = new Date(this.clock.now()).toISOString();
    const drafts: DraftEvent[] = [];
    const answered: string[] = [];
    const snoozed: string[] = [];
    for (const ans of r.answers) {
      const it = this.hub.state.attention[ans.id];
      if (ans.type === 'later') {
        const max = it.urgency === 'urgent' ? 4 * 3600_000 : 24 * 3600_000;
        const until = Math.min(ans.untilMs, this.clock.now() + max);
        drafts.push(draft('attention.snoozed', USER, { id: ans.id, until: new Date(until).toISOString() }));
        snoozed.push(ans.id);
      } else {
        drafts.push(draft('attention.answered', USER, { id: ans.id, answer: ans.type === 'option' ? { optionKey: ans.optionKey, via: 'ui', at: now } : { text: ans.text, via: 'ui', at: now } }));
        answered.push(ans.id);
      }
    }
    await this.hub.commit(drafts);
    await this.afterAnswer(answered, true);
    return { ok: true, errors: [], answered, snoozed };
  }

  async userAnswer(id: string, answer: { optionKey?: string; text?: string }): Promise<void> {
    const it = this.hub.state.attention[id];
    if (!it || (it.status !== 'open' && it.status !== 'snoozed')) throw new Error(`${id} is not open`);
    if (answer.optionKey && !it.options.some((o) => o.key === answer.optionKey)) throw new Error('unknown option');
    await this.hub.commit(draft('attention.answered', USER, { id, answer: { ...answer, via: 'ui', at: new Date(this.clock.now()).toISOString() } }));
    await this.afterAnswer([id], true);
  }

  async userSnooze(id: string, minutes: number): Promise<void> {
    const it = this.hub.state.attention[id];
    if (!it) return;
    const max = it.urgency === 'urgent' ? 240 : 1440;
    await this.hub.commit(draft('attention.snoozed', USER, { id, until: new Date(this.clock.now() + Math.min(minutes, max) * 60_000).toISOString() }));
  }

  /** After user answers: app items are handled locally; approvals become grants; the rest go to the manager. */
  private async afterAnswer(ids: string[], notifyManager: boolean): Promise<void> {
    const st = this.hub.state;
    const forManager: AttentionItem[] = [];
    for (const id of ids) {
      const it = st.attention[id];
      if (!it) continue;
      if (it.origin === 'app') {
        await this.hub.commit(draft('attention.applied', APP, { id, actionTaken: it.answer?.optionKey === 'retry' ? 'retry requested' : 'dismissed' }));
        if (it.answer?.optionKey === 'retry' && it.worker) {
          const s = st.sessions[st.workers[it.worker]];
          if (s && !this.d.ptys.get(s.id)) void this.spawnSession(s, true).catch(() => undefined);
        }
        continue;
      }
      if (it.ticket) {
        const r = st.approvals[it.ticket];
        const opt = it.options.find((o) => o.key === it.answer?.optionKey);
        const approve = !!opt && /^(y|yes|approve|allow|ok|a)$/i.test(opt.key) || /approve|yes|allow/i.test(opt?.label ?? '');
        if (r && approve && !opt?.action) {
          const gid = this.hub.nextId('G');
          await this.hub.commit(draft('grant.created', APP, { id: gid, task: r.task, worker: r.worker, pattern: r.exactCommandOrTool.startsWith('mcp__') ? r.exactCommandOrTool : `Bash(${r.exactCommandOrTool})`, scope: 'once', source: it.id }));
        }
        if (r) await this.hub.commit(draft('approval.decided', APP, { id: r.id, decision: approve ? 'granted' : 'denied', attention: it.id }));
      }
      forManager.push(st.attention[id]);
    }
    if (notifyManager && forManager.length) {
      const lines = forManager.map((it) => {
        const opt = it.options.find((o) => o.key === it.answer?.optionKey);
        const ans = opt ? `${opt.key} (${opt.label})${opt.action ? ` → execute_approved(attention_id="${it.id}", action="${opt.action}")` : ''}` : `"${it.answer?.text}"`;
        return `${it.id} [${it.task}${it.workerName ? ` · ${it.workerName}` : ''}${it.ticket ? ` · ticket ${it.ticket}` : ''}]: ${it.question}\n  → user answered: ${ans}`;
      });
      for (const it of forManager) {
        await this.delivery.enqueue('user_decision', `User decision ${it.id}:\n${lines[forManager.indexOf(it)]}\nVerify with list_attention, act, then ack_attention.`, { attention: it.id, task: it.task ?? '' });
      }
    }
  }

  async userCancelTask(taskId: string): Promise<void> {
    const t = this.hub.state.tasks[taskId];
    if (!t || TERMINAL_TASK_STATUSES.includes(t.status)) return;
    await this.hub.commit(draft('task.status_changed', USER, { id: taskId, from: t.status, to: 'cancelled', reason: 'cancelled by user' }));
    await this.cancelTaskEffects(taskId);
    await this.delivery.enqueue('system', `The user cancelled ${taskId} (${t.title}). Its worker is being stopped.`, { task: taskId, event: 'task_cancelled' });
  }

  async userSetPaused(paused: boolean): Promise<void> {
    if (paused && !this.hub.state.usage.paused) await this.commitUsage([draft('usage.limit_hit', USER, { source: 'user' })]);
    if (!paused && this.hub.state.usage.paused) await this.commitUsage([draft('usage.limit_cleared', USER, {})]);
  }

  async userRestartSession(session: string): Promise<void> {
    const s = this.hub.state.sessions[session];
    if (!s || this.d.ptys.get(session)) return;
    await this.spawnSession(s, true);
  }
}
