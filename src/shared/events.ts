import type {
  Actor,
  AttentionItem,
  AttentionAnswer,
  ApprovalRequest,
  ChannelKind,
  Escalation,
  PreAuthorization,
  SessionRole,
  SessionState,
  TaskKind,
  TaskStatus,
  Task,
  UsageWindow,
} from './types';

/** Event payloads keyed by event type. See SPEC.md §4.3 and §18.6. */
export interface EventMap {
  'app.started': { version: string; claudeVersion?: string; pid: number; bootId: string };
  'app.stopping': { reason: string };
  'log.torn_tail_repaired': { bytes: number; file: string };
  'settings.changed': { key: string; value: unknown };

  'task.created': {
    id: string;
    title: string;
    description: string;
    kind: TaskKind;
    repo?: string;
    baseBranch?: string;
    priority: number;
    escalation: Escalation;
    preAuthorized: PreAuthorization[];
    skillsHint: string[];
    dependsOn: string[];
    mcpServers: string[];
    source: string;
  };
  'task.updated': { id: string; patch: Partial<Pick<Task, 'title' | 'description' | 'priority' | 'escalation' | 'notes' | 'skillsHint' | 'autoAllow' | 'preAuthorized' | 'dependsOn' | 'kind' | 'repo' | 'baseBranch'>> };
  'task.status_changed': { id: string; from: TaskStatus; to: TaskStatus; reason: string };
  'task.assigned': { id: string; worker: string; branch?: string; workspace?: string };
  'task.completed': { id: string; outcome: 'success' | 'partial' | 'failed'; summary: string; artifacts: { path: string; desc?: string }[]; branch?: string; verification?: string };
  'progress.reported': { task: string; worker: string; summary: string; percent?: number };

  'session.spawn_requested': { session: string; role: SessionRole; name: string; worker?: string; task?: string; cwd: string; resume: boolean };
  'session.started': { session: string; pid: number };
  'session.state_changed': { session: string; state: SessionState; source: string };
  'session.exited': { session: string; exitCode: number; signal?: number; expected: boolean };
  'session.cleaned_up': { session: string; worktreeRemoved: boolean; branchDeleted: boolean };
  'worker.spawned': { worker: string; session: string; name: string; task: string };
  'worker.spawn_failed': { worker: string; session: string; task: string; error: string };

  'permission.requested': { id: string; session: string; worker?: string; task?: string; tool: string; inputSummary: string };
  'permission.decided': { id: string; decision: 'allow' | 'deny' | 'expired'; by: string };
  'grant.created': { id: string; task: string; worker?: string; pattern: string; scope: 'once' | 'task'; source: string; expiresAt?: string };
  'grant.consumed': { id: string };

  'approval.requested': Omit<ApprovalRequest, 'status' | 'attention'>;
  'approval.decided': { id: string; decision: 'granted' | 'denied' | 'escalated'; attention?: string; message?: string };

  'attention.created': AttentionItem;
  'attention.alerted': { alertId: string; kind: 'first' | 'new' | 'reminder' | 'boot'; itemIds: string[] };
  'attention.snoozed': { id: string; until: string };
  'attention.unsnoozed': { id: string };
  'attention.answered': { id: string; answer: AttentionAnswer };
  'attention.applied': { id: string; actionTaken: string };
  'attention.withdrawn': { id: string; reason: 'task_cancelled' | 'worker_gone' | 'superseded_by_user_answer' };
  'attention.executed': { id: string; action: string; ok: boolean; output: string };
  'preauth.executed': { task: string; index: number; action: string; ok: boolean; output: string };
  'alert.failed': { error: string };
  'alert.clicked': { alertId?: string };

  'event.pushed': { id: string; kind: ChannelKind; content: string; meta: Record<string, string>; via: 'channel' | 'paste' };
  'event.acked': { id: string };
  'event.redelivered': { id: string; pushes: number };

  'message.observed': { from: string; to: string; summary: string };

  'usage.sample': {
    session: string;
    model?: string;
    costUsd?: number;
    durationMs?: number;
    apiMs?: number;
    linesAdded?: number;
    linesRemoved?: number;
    ctxUsedPct?: number | null;
    ctxSize?: number;
    inTok?: number;
    outTok?: number;
    cur?: { in?: number; out?: number; cacheCreate?: number; cacheRead?: number } | null;
  };
  'usage.plan_sample': { fiveHour?: UsageWindow; sevenDay?: UsageWindow };
  'usage.warning': { pct: number; window: string };
  'usage.limit_hit': { source: string; resetsAt?: number };
  'usage.limit_cleared': Record<string, never>;

  'report.created': { id: string; task: string; kind: 'completion' | 'fyi'; summary: string };
  'skill.created': { name: string; path: string; scope: string; backup?: string; update: boolean };
  'leak.detected': { session?: string; kind: string; detail: string };
  'banner.shown': { id: string; level: 'info' | 'warn' | 'error'; text: string };
  'banner.cleared': { id: string };
}

export type EventType = keyof EventMap;

export interface EventEnvelope<T extends EventType = EventType> {
  v: 1;
  seq: number;
  id: string;
  ts: string;
  type: T;
  actor: Actor;
  data: EventMap[T];
}

/** An event before the store assigns seq/id/ts. */
export interface DraftEvent<T extends EventType = EventType> {
  type: T;
  actor: Actor;
  data: EventMap[T];
}

export function draft<T extends EventType>(type: T, actor: Actor, data: EventMap[T]): DraftEvent<T> {
  return { type, actor, data };
}

export const APP: Actor = { role: 'app' };
export const USER: Actor = { role: 'user' };
