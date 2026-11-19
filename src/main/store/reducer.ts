import type { EventEnvelope } from '../../shared/events';
import {
  LIVE_SESSION_STATES,
  type Counters,
  type Session,
  type State,
  type Task,
  type TaskStatus,
} from '../../shared/types';

/** Legal task transitions (SPEC §4.4 + §18.6). */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  inbox: ['planned', 'queued', 'running', 'cancelled'],
  planned: ['queued', 'running', 'cancelled', 'inbox'],
  queued: ['running', 'planned', 'cancelled'],
  running: ['blocked', 'review', 'done', 'failed', 'cancelled', 'queued'],
  blocked: ['running', 'review', 'done', 'failed', 'cancelled'],
  review: ['done', 'running', 'failed', 'cancelled'],
  done: [],
  failed: ['queued', 'running'],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

function bump(counters: Counters, key: keyof Counters, id: string | undefined, prefix = key as string): void {
  if (!id) return;
  const m = new RegExp(`^${prefix}(\\d+)$`).exec(id);
  if (m) counters[key] = Math.max(counters[key], Number(m[1]));
}

function touchTask(t: Task, ts: string): void {
  t.updatedAt = ts;
}

/**
 * Pure-ish reducer: mutates and returns `s` (callers pass a working copy).
 * Identical code is used for live appends and replay.
 */
export function reduce(s: State, e: EventEnvelope): State {
  s.seq = e.seq;
  const ts = e.ts;
  switch (e.type) {
    case 'app.started': {
      const d = e.data as EventEnvelopeData<'app.started'>;
      s.bootId = d.bootId;
      for (const sess of Object.values(s.sessions)) {
        if (LIVE_SESSION_STATES.includes(sess.state) && sess.state !== 'finished') {
          sess.state = 'interrupted';
          sess.stateSince = ts;
        }
      }
      // pushed-but-unacked events will be re-pushed by the delivery engine on boot
      for (const p of Object.values(s.pending)) p.pushedAt = undefined;
      break;
    }
    case 'settings.changed': {
      const d = e.data as EventEnvelopeData<'settings.changed'>;
      (s.config as unknown as Record<string, unknown>)[d.key] = d.value;
      break;
    }
    case 'task.created': {
      const d = e.data as EventEnvelopeData<'task.created'>;
      bump(s.counters, 'T', d.id);
      s.tasks[d.id] = {
        id: d.id,
        title: d.title,
        description: d.description,
        kind: d.kind,
        repo: d.repo,
        baseBranch: d.baseBranch,
        priority: d.priority,
        escalation: d.escalation,
        preAuthorized: d.preAuthorized,
        autoAllow: [],
        skillsHint: d.skillsHint,
        dependsOn: d.dependsOn,
        mcpServers: d.mcpServers,
        source: d.source,
        status: 'inbox',
        createdAt: ts,
        updatedAt: ts,
      };
      break;
    }
    case 'task.updated': {
      const d = e.data as EventEnvelopeData<'task.updated'>;
      const t = s.tasks[d.id];
      if (t) {
        Object.assign(t, d.patch);
        touchTask(t, ts);
      }
      break;
    }
    case 'task.status_changed': {
      const d = e.data as EventEnvelopeData<'task.status_changed'>;
      const t = s.tasks[d.id];
      if (t) {
        t.status = d.to;
        touchTask(t, ts);
      }
      break;
    }
    case 'task.assigned': {
      const d = e.data as EventEnvelopeData<'task.assigned'>;
      const t = s.tasks[d.id];
      if (t) {
        t.worker = d.worker;
        t.branch = d.branch;
        t.workspace = d.workspace;
        touchTask(t, ts);
      }
      break;
    }
    case 'task.completed': {
      const d = e.data as EventEnvelopeData<'task.completed'>;
      const t = s.tasks[d.id];
      if (t) {
        t.outcome = { outcome: d.outcome, summary: d.summary, artifacts: d.artifacts, verification: d.verification };
        if (d.branch) t.branch = d.branch;
        touchTask(t, ts);
      }
      break;
    }
    case 'progress.reported': {
      const d = e.data as EventEnvelopeData<'progress.reported'>;
      const t = s.tasks[d.task];
      if (t) {
        t.lastProgress = { summary: d.summary, percent: d.percent, at: ts };
        touchTask(t, ts);
      }
      break;
    }
    case 'session.spawn_requested': {
      const d = e.data as EventEnvelopeData<'session.spawn_requested'>;
      bump(s.counters, 'W', d.worker);
      const prev = s.sessions[d.session];
      const sess: Session = {
        id: d.session,
        role: d.role,
        name: d.name,
        workerId: d.worker,
        taskId: d.task,
        cwd: d.cwd,
        state: 'spawning',
        stateSince: ts,
        crashCount: prev?.crashCount ?? 0,
        cleanedUp: false,
        resumeCount: (prev?.resumeCount ?? 0) + (d.resume ? 1 : 0),
        startedAt: prev?.startedAt,
      };
      s.sessions[d.session] = sess;
      if (d.role === 'manager') s.managerSession = d.session;
      if (d.worker) s.workers[d.worker] = d.session;
      break;
    }
    case 'session.started': {
      const d = e.data as EventEnvelopeData<'session.started'>;
      const sess = s.sessions[d.session];
      if (sess) {
        sess.pid = d.pid;
        sess.startedAt = sess.startedAt ?? ts;
        sess.lastActivity = ts;
      }
      break;
    }
    case 'session.state_changed': {
      const d = e.data as EventEnvelopeData<'session.state_changed'>;
      const sess = s.sessions[d.session];
      if (sess && sess.state !== d.state) {
        sess.state = d.state;
        sess.stateSince = ts;
      }
      if (sess) sess.lastActivity = ts;
      break;
    }
    case 'session.exited': {
      const d = e.data as EventEnvelopeData<'session.exited'>;
      const sess = s.sessions[d.session];
      if (sess) {
        sess.exitCode = d.exitCode;
        sess.state = d.expected ? 'exited' : 'crashed';
        sess.stateSince = ts;
        sess.pid = undefined;
        if (!d.expected) sess.crashCount++;
      }
      break;
    }
    case 'session.cleaned_up': {
      const d = e.data as EventEnvelopeData<'session.cleaned_up'>;
      const sess = s.sessions[d.session];
      if (sess) sess.cleanedUp = true;
      break;
    }
    case 'worker.spawned':
    case 'worker.spawn_failed':
      break;
    case 'permission.requested': {
      const d = e.data as EventEnvelopeData<'permission.requested'>;
      bump(s.counters, 'P', d.id);
      s.permissions[d.id] = { ...d, status: 'pending', createdAt: ts };
      break;
    }
    case 'permission.decided': {
      const d = e.data as EventEnvelopeData<'permission.decided'>;
      const p = s.permissions[d.id];
      if (p) p.status = d.decision === 'allow' ? 'allowed' : d.decision === 'deny' ? 'denied' : 'expired';
      break;
    }
    case 'grant.created': {
      const d = e.data as EventEnvelopeData<'grant.created'>;
      bump(s.counters, 'G', d.id);
      s.grants[d.id] = { ...d, consumed: false };
      break;
    }
    case 'grant.consumed': {
      const d = e.data as EventEnvelopeData<'grant.consumed'>;
      const g = s.grants[d.id];
      if (g && g.scope === 'once') g.consumed = true;
      break;
    }
    case 'approval.requested': {
      const d = e.data as EventEnvelopeData<'approval.requested'>;
      bump(s.counters, 'R', d.id);
      s.approvals[d.id] = { ...d, status: 'pending' };
      break;
    }
    case 'approval.decided': {
      const d = e.data as EventEnvelopeData<'approval.decided'>;
      const a = s.approvals[d.id];
      if (a) {
        a.status = d.decision;
        if (d.attention) a.attention = d.attention;
      }
      break;
    }
    case 'attention.created': {
      const d = e.data as EventEnvelopeData<'attention.created'>;
      bump(s.counters, 'A', d.id);
      s.attention[d.id] = { ...d };
      break;
    }
    case 'attention.alerted': {
      const d = e.data as EventEnvelopeData<'attention.alerted'>;
      s.alert.anchor = ts;
      s.alert.pendingSince = undefined;
      s.alert.deadline = undefined;
      s.alert.lastAlertItemIds = d.itemIds;
      for (const id of d.itemIds) {
        const a = s.attention[id];
        if (a) {
          a.alertedAt = a.alertedAt ?? ts;
          a.alertCount = (a.alertCount ?? 0) + 1;
        }
      }
      if (d.kind === 'reminder') s.alert.step++;
      else if (d.kind === 'first') s.alert.step = 0;
      break;
    }
    case 'attention.snoozed': {
      const d = e.data as EventEnvelopeData<'attention.snoozed'>;
      const a = s.attention[d.id];
      if (a && (a.status === 'open' || a.status === 'snoozed')) {
        a.status = 'snoozed';
        a.snoozeUntil = d.until;
        a.snoozeCount++;
      }
      break;
    }
    case 'attention.unsnoozed': {
      const d = e.data as EventEnvelopeData<'attention.unsnoozed'>;
      const a = s.attention[d.id];
      if (a && a.status === 'snoozed') {
        a.status = 'open';
        a.snoozeUntil = undefined;
      }
      break;
    }
    case 'attention.answered': {
      const d = e.data as EventEnvelopeData<'attention.answered'>;
      const a = s.attention[d.id];
      if (a && (a.status === 'open' || a.status === 'snoozed')) {
        a.status = 'answered';
        a.answer = d.answer;
        a.snoozeUntil = undefined;
      }
      break;
    }
    case 'attention.applied': {
      const d = e.data as EventEnvelopeData<'attention.applied'>;
      const a = s.attention[d.id];
      if (a && a.status === 'answered') {
        a.status = 'applied';
        a.appliedAt = ts;
        a.actionTaken = d.actionTaken;
      }
      break;
    }
    case 'attention.withdrawn': {
      const d = e.data as EventEnvelopeData<'attention.withdrawn'>;
      const a = s.attention[d.id];
      if (a && (a.status === 'open' || a.status === 'snoozed')) {
        a.status = 'withdrawn';
        a.withdrawnReason = d.reason;
      }
      break;
    }
    case 'attention.executed': {
      const d = e.data as EventEnvelopeData<'attention.executed'>;
      const a = s.attention[d.id];
      if (a && d.ok) a.executed = true;
      break;
    }
    case 'preauth.executed': {
      const d = e.data as EventEnvelopeData<'preauth.executed'>;
      const t = s.tasks[d.task];
      if (t && d.ok && t.preAuthorized[d.index]) t.preAuthorized[d.index].executed = true;
      break;
    }
    case 'event.pushed': {
      const d = e.data as EventEnvelopeData<'event.pushed'>;
      bump(s.counters, 'E', d.id);
      const prev = s.pending[d.id];
      s.pending[d.id] = {
        id: d.id,
        kind: d.kind,
        content: d.content,
        meta: d.meta,
        pushedAt: ts,
        pushes: (prev?.pushes ?? 0) + 1,
        acked: prev?.acked ?? false,
        createdAt: prev?.createdAt ?? ts,
      };
      break;
    }
    case 'event.redelivered': {
      const d = e.data as EventEnvelopeData<'event.redelivered'>;
      const p = s.pending[d.id];
      if (p) {
        p.pushes = d.pushes;
        p.pushedAt = ts;
      }
      break;
    }
    case 'event.acked': {
      const d = e.data as EventEnvelopeData<'event.acked'>;
      const p = s.pending[d.id];
      if (p) p.acked = true;
      break;
    }
    case 'usage.sample': {
      const d = e.data as EventEnvelopeData<'usage.sample'>;
      const prev = s.usage.perSession[d.session];
      let priorCostUsd = prev?.priorCostUsd ?? 0;
      let priorInTok = prev?.priorInTok ?? 0;
      let priorOutTok = prev?.priorOutTok ?? 0;
      // counters are cumulative per process; a decrease means a new segment (resume)
      if (prev && d.costUsd !== undefined && prev.costUsd !== undefined && d.costUsd < prev.costUsd) {
        priorCostUsd += prev.costUsd;
        priorInTok += prev.inTok ?? 0;
        priorOutTok += prev.outTok ?? 0;
      }
      s.usage.perSession[d.session] = { ...d, updatedAt: ts, priorCostUsd, priorInTok, priorOutTok };
      break;
    }
    case 'usage.plan_sample': {
      const d = e.data as EventEnvelopeData<'usage.plan_sample'>;
      s.usage.plan = { fiveHour: d.fiveHour, sevenDay: d.sevenDay, updatedAt: ts };
      break;
    }
    case 'usage.warning':
      s.usage.warned = true;
      break;
    case 'usage.limit_hit': {
      const d = e.data as EventEnvelopeData<'usage.limit_hit'>;
      s.usage.paused = true;
      s.usage.pausedSource = d.source;
      s.usage.resumesAt = d.resetsAt;
      break;
    }
    case 'usage.limit_cleared':
      s.usage.paused = false;
      s.usage.pausedSource = undefined;
      s.usage.resumesAt = undefined;
      s.usage.warned = false;
      break;
    case 'report.created': {
      const d = e.data as EventEnvelopeData<'report.created'>;
      bump(s.counters, 'RP', d.id, 'RP');
      s.reports[d.id] = { ...d, createdAt: ts };
      break;
    }
    case 'skill.created': {
      const d = e.data as EventEnvelopeData<'skill.created'>;
      s.skills[d.name] = { path: d.path, scope: d.scope, updatedAt: ts };
      break;
    }
    case 'leak.detected': {
      const d = e.data as EventEnvelopeData<'leak.detected'>;
      s.leaks.push({ at: ts, ...d });
      if (s.leaks.length > 200) s.leaks.shift();
      break;
    }
    case 'banner.shown': {
      const d = e.data as EventEnvelopeData<'banner.shown'>;
      s.banners = s.banners.filter((b) => b.id !== d.id);
      s.banners.push({ ...d, at: ts });
      break;
    }
    case 'banner.cleared': {
      const d = e.data as EventEnvelopeData<'banner.cleared'>;
      s.banners = s.banners.filter((b) => b.id !== d.id);
      break;
    }
    default:
      // unknown or informational event types are preserved in the log and ignored here
      break;
  }
  return s;
}

type EventEnvelopeData<T extends import('../../shared/events').EventType> = import('../../shared/events').EventMap[T];

export function replay(events: EventEnvelope[], initial: State): State {
  let s = initial;
  for (const e of events) s = reduce(s, e);
  return s;
}
