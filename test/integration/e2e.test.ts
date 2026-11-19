import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import * as pty from 'node-pty';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Orchestrator } from '../../src/main/app/orchestrator';
import { PtyManager } from '../../src/main/pty/pty-manager';
import { EventStore } from '../../src/main/store/event-store';
import { StateHub } from '../../src/main/store/state-hub';
import { AttentionScheduler } from '../../src/main/attention/scheduler';
import { NotificationService, RecordingNotifier } from '../../src/main/notify/notification-service';
import { tmpDir } from '../helpers';

const ROOT = path.resolve(__dirname, '../..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | false, ms = 20_000, label = 'condition'): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timeout waiting for ${label}`);
    await sleep(100);
  }
}
function readLog(dir: string, name: string): Record<string, any>[] {
  const f = path.join(dir, `${name}.jsonl`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}
async function mcpAs(url: string, token: string) {
  const c = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return {
    c,
    call: async (name: string, args: Record<string, unknown>) => {
      const r = await c.callTool({ name, arguments: args });
      const text = (r.content as { text: string }[])[0].text;
      if (r.isError) throw new Error(text);
      return JSON.parse(text);
    },
  };
}
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }).toString();
}

describe('end-to-end with fake claude', () => {
  const home = tmpDir('ab-home-');
  const logs = path.join(home, 'fake-logs');
  const repo = tmpDir('ab-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@x');
  git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');

  const hub = new StateHub(new EventStore(path.join(home, 'events.jsonl')));
  const ptys = new PtyManager((file, args, o) => pty.spawn(file, args, o));
  const rec = new RecordingNotifier();
  const notify = new NotificationService(rec);
  let orch: Orchestrator;
  let sched: AttentionScheduler;
  afterAll(async () => {
    sched?.stop();
    await orch?.shutdown();
  });

  it('runs the whole flow: new task → spawn → done → merge escalation → batch answer → merge', async () => {
    await hub.boot();
    hub.state.config.coalesceNormalMs = 500;
    orch = new Orchestrator({
      hub, ptys, home, resources: path.join(ROOT, 'resources'), claudePath: path.join(ROOT, 'scripts', 'fake-claude.mjs'),
      loginPath: process.env.PATH!, baseEnv: { ...process.env, TMPDIR: logs }, // TMPDIR survives the env allowlist
    });
    await orch.start();
    sched = new AttentionScheduler(hub, notify);
    sched.start(false);
    await orch.ensureManager();
    const mgrSess = hub.state.managerSession!;
    const fakeLogs = path.join(logs, 'fake-claude');
    await until(() => hub.state.sessions[mgrSess]?.state === 'idle' || hub.state.sessions[mgrSess]?.state === 'ready', 20_000, 'manager ready');
    await until(() => orch.bus.hasChannel(mgrSess), 20_000, 'manager channel');
    const mstart = readLog(fakeLogs, 'manager').filter((l) => l.kind === 'start').pop()!;
    expect(mstart.env.TERM_PROGRAM).toBe('agentboard');
    expect(mstart.env.CLAUDECODE).toBeUndefined();
    expect(mstart.env.NO_PROXY).toMatch(/127\.0\.0\.1/);
    const mgr = await mcpAs(orch.bus.url, mstart.env.AGENTBOARD_TOKEN);

    // 1. user adds a task -> new_task channel event reaches the manager
    const tid = await orch.userAddTask({ title: 'Add a greeting file', repo, kind: 'code' });
    const newTask = await until(() => readLog(fakeLogs, 'manager').find((l) => l.kind === 'channel' && l.meta.kind === 'new_task' && l.meta.task === tid), 10_000, 'new_task channel');
    await mgr.call('update_task', { task_id: tid, patch: { status: 'planned' }, ack: [newTask.meta.id] });
    expect(hub.state.pending[newTask.meta.id].acked).toBe(true);

    // 2. spawn a worker with a meaningful name
    const sp = await mgr.call('spawn_worker', { task_id: tid, name: 'greeting-file', brief_markdown: '# Add greeting\n## Goal\nAdd hello.txt', skills: [] });
    expect(sp).toMatchObject({ name: 'greeting-file', status: 'spawning' });
    await until(() => hub.state.tasks[tid].status === 'running', 20_000, 'task running');
    const wsess = hub.state.workers[sp.worker_id];
    const wstart = await until(() => readLog(fakeLogs, 'greeting-file').filter((l) => l.kind === 'start').pop(), 10_000, 'worker log');
    expect(wstart.argv).toContain('--name');
    expect(wstart.argv[wstart.argv.indexOf('--name') + 1]).toBe('greeting-file');
    expect(wstart.env.PATH.split(':')[0]).toMatch(/bin\/shims$/);
    expect(fs.readFileSync(path.join(home, 'tasks', tid, 'brief.md'), 'utf8')).toMatch(/Your session name: `greeting-file`/);
    await until(() => readLog(fakeLogs, 'manager').find((l) => l.kind === 'channel' && l.meta.kind === 'worker_spawned'), 10_000, 'worker_spawned');

    // 3. notification leak stimuli + permission floor via the real hook relay
    const wp = ptys.get(wsess)!;
    let rendererSaw = '';
    wp.on('data', (d: string) => (rendererSaw += d));
    await until(() => ['idle', 'ready'].includes(hub.state.sessions[wsess].state), 10_000, 'worker idle');
    await wp.injectPaste('!bell');
    await until(() => wp.filter.counters.bel > 0, 10_000, 'bell swallowed');
    await wp.injectPaste('!tool Bash {"command":"git push origin main"}');
    const pre = await until(() => readLog(fakeLogs, 'greeting-file').find((l) => l.kind === 'pretool'), 10_000, 'pretool');
    expect(pre.res).toMatch(/"permissionDecision":"deny"/);
    await wp.injectPaste('!tool SendMessage {"to":"pricing-research","message":"hi"}');
    await until(() => readLog(fakeLogs, 'greeting-file').filter((l) => l.kind === 'pretool').length >= 2, 10_000, 'pretool 2');
    expect(readLog(fakeLogs, 'greeting-file').filter((l) => l.kind === 'pretool')[1].res).toMatch(/only message @manager/);
    expect(rendererSaw).not.toMatch(/\x07/);
    expect(rendererSaw).not.toMatch(/\x1b\]9;/);

    // 4. worker does the work and calls done
    const cwd = hub.state.sessions[wsess].cwd;
    fs.writeFileSync(path.join(cwd, 'hello.txt'), 'hello\n');
    const worker = await mcpAs(orch.bus.url, wstart.env.AGENTBOARD_TOKEN);
    await expect(worker.call('done', { outcome: 'success', summary_md: 'added', verification: 'cat hello.txt' })).rejects.toThrow(/UNCOMMITTED_CHANGES/);
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'add hello');
    await worker.call('report_progress', { summary: 'committed' });
    await worker.call('done', { outcome: 'success', summary_md: 'added hello.txt', verification: 'cat hello.txt' });
    expect(hub.state.tasks[tid].status).toBe('review');
    await until(() => readLog(fakeLogs, 'manager').find((l) => l.kind === 'channel' && l.meta.kind === 'worker_done'), 10_000, 'worker_done');
    await expect(worker.call('spawn_worker', {})).rejects.toThrow();

    // 5. manager escalates the merge; one coalesced alert
    const esc = await mgr.call('escalate', {
      task_id: tid, kind: 'merge', question: 'Merge greeting-file into main?', irreversible: true,
      options: [{ key: 'a', label: 'Merge', action: 'git.merge' }, { key: 'b', label: 'Hold' }],
      recommendation: { option_key: 'a', rationale: 'tests pass' },
    });
    await until(() => rec.shown.length === 1, 5_000, 'alert');
    expect(rec.shown[0].body).toMatch(/1 item needs you/);
    expect(rec.counts.open).toBe(1);
    await expect(mgr.call('execute_approved', { attention_id: esc.attention_id, action: 'git.merge' })).rejects.toThrow(/NOT_APPROVED/);

    // 6. user batch-answers; decision delivered; manager executes the merge
    const n = esc.attention_id.slice(1);
    const r = await orch.userAnswerBatch(`${n} a`);
    expect(r.ok).toBe(true);
    expect(rec.counts.open).toBe(0);
    const dec = await until(() => readLog(fakeLogs, 'manager').find((l) => l.kind === 'channel' && l.meta.kind === 'user_decision'), 10_000, 'user_decision');
    expect(dec.content).toMatch(/execute_approved/);
    const ex = await mgr.call('execute_approved', { attention_id: esc.attention_id, action: 'git.merge' });
    expect(ex.ok).toBe(true);
    await expect(mgr.call('execute_approved', { attention_id: esc.attention_id, action: 'git.merge' })).rejects.toThrow(/ALREADY_EXECUTED/);
    await mgr.call('ack_attention', { attention_id: esc.attention_id, action_taken: 'merged' });
    expect(hub.state.tasks[tid].status).toBe('done');
    expect(fs.existsSync(path.join(repo, 'hello.txt'))).toBe(true);
    expect(hub.state.attention[esc.attention_id].status).toBe('applied');

    // 7. notification discipline: only attention-origin alerts, exactly one
    expect(notify.log.every((x) => x.origin === 'attention')).toBe(true);
    expect(rec.shown).toHaveLength(1);
    await until(() => fs.existsSync(path.join(home, 'board.md')), 3000, 'board.md');
    expect(fs.readFileSync(path.join(home, 'board.md'), 'utf8')).toMatch(/Add a greeting file/);
    await mgr.c.close();
    await worker.c.close();
  }, 120_000);
});
