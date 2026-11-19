// Core domain types shared by main and renderer. See SPEC.md §4 and §18.

export type Role = 'user' | 'manager' | 'worker' | 'app' | 'system';

export interface Actor {
  role: Role;
  id?: string;
}

export type TaskKind = 'code' | 'research' | 'ops' | 'mixed';

export type TaskStatus =
  | 'inbox'
  | 'planned'
  | 'queued'
  | 'running'
  | 'blocked'
  | 'review'
  | 'done'
  | 'failed'
  | 'cancelled';

export const TERMINAL_TASK_STATUSES: TaskStatus[] = ['done', 'failed', 'cancelled'];

export type EscalationPreset = 'default' | 'cautious' | 'autonomous' | 'custom';

export interface EscalationRule {
  when: string;
  action: 'ask' | 'decide' | 'fyi';
  note?: string;
}

export interface Escalation {
  preset: EscalationPreset;
  text?: string;
  rules?: EscalationRule[];
}

export type PreauthAction = 'git.push' | 'git.push_branch' | 'git.merge' | 'send_message' | 'deploy' | 'other';

export interface PreAuthorization {
  action: PreauthAction;
  scope: string;
  quote?: string;
  executed?: boolean;
}

export interface Task {
  id: string; // T<n>
  title: string;
  description: string;
  kind: TaskKind;
  repo?: string;
  baseBranch?: string;
  priority: number; // 1 (highest) .. 5
  escalation: Escalation;
  preAuthorized: PreAuthorization[];
  autoAllow: string[];
  skillsHint: string[];
  dependsOn: string[];
  mcpServers: string[];
  source: string;
  status: TaskStatus;
  worker?: string; // worker id W<n>
  branch?: string;
  workspace?: string;
  lastProgress?: { summary: string; percent?: number; at: string };
  notes?: string;
  outcome?: { outcome: 'success' | 'partial' | 'failed'; summary: string; artifacts: { path: string; desc?: string }[]; verification?: string };
  createdAt: string;
  updatedAt: string;
}

export type SessionRole = 'manager' | 'worker';

export type SessionState =
  | 'spawning'
  | 'needs_user_dialog'
  | 'ready'
  | 'idle'
  | 'busy'
  | 'awaiting_permission'
  | 'waiting_on_manager'
  | 'stalled'
  | 'paused_usage'
  | 'exiting'
  | 'exited'
  | 'crashed'
  | 'interrupted'
  | 'finished';

export const LIVE_SESSION_STATES: SessionState[] = [
  'spawning',
  'needs_user_dialog',
  'ready',
  'idle',
  'busy',
  'awaiting_permission',
  'waiting_on_manager',
  'stalled',
  'paused_usage',
  'finished',
];

export interface Session {
  id: string; // claude session uuid
  role: SessionRole;
  name: string; // claude --name; manager = "manager"
  workerId?: string;
  taskId?: string;
  cwd: string;
  pid?: number;
  state: SessionState;
  stateSince: string;
  lastActivity?: string;
  startedAt?: string;
  exitCode?: number;
  crashCount: number;
  cleanedUp: boolean;
  resumeCount: number;
}

export type AttentionKind = 'decision' | 'approval' | 'stuck' | 'merge' | 'app';
export type AttentionStatus = 'open' | 'snoozed' | 'answered' | 'applied' | 'withdrawn';
export type Urgency = 'normal' | 'urgent';

export type ExecutableAction = 'git.merge' | 'git.push' | 'git.push_branch' | 'worktree.cleanup';

export interface AttentionOption {
  key: string;
  label: string;
  consequence?: string;
  action?: ExecutableAction;
}

export interface AttentionAnswer {
  optionKey?: string;
  text?: string;
  via: 'ui' | 'notification_reply' | 'chat_quote';
  quote?: string;
  at: string;
}

export interface AttentionItem {
  id: string; // A<n>
  kind: AttentionKind;
  origin: 'manager' | 'app';
  task?: string;
  worker?: string; // worker id
  workerName?: string;
  ticket?: string; // approval ticket R<n>
  question: string;
  detail?: string;
  options: AttentionOption[];
  recommendation?: { optionKey: string; rationale: string };
  irreversible: boolean;
  urgency: Urgency;
  blocks: { summary: string; workers: string[]; tasks: string[] };
  status: AttentionStatus;
  createdAt: string;
  snoozeUntil?: string;
  snoozeCount: number;
  answer?: AttentionAnswer;
  appliedAt?: string;
  actionTaken?: string;
  executed?: boolean;
  deliveredCount: number;
  withdrawnReason?: string;
  alertedAt?: string;
  alertCount: number;
}

export interface Grant {
  id: string;
  task: string;
  worker?: string;
  pattern: string; // permission-rule style pattern, e.g. "mcp__gmail__send_message" or "Bash(npm publish)"
  scope: 'once' | 'task';
  source: string; // attention id, approval ticket, or "preauth"
  expiresAt?: string;
  consumed: boolean;
}

export interface ApprovalRequest {
  id: string; // R<n>
  task: string;
  worker: string;
  actionKind: string;
  summary: string;
  exactCommandOrTool: string;
  why: string;
  status: 'pending' | 'granted' | 'denied' | 'escalated';
  attention?: string;
  createdAt: string;
}

export interface PermissionRequest {
  id: string; // P<n>
  task?: string;
  worker?: string;
  session: string;
  tool: string;
  inputSummary: string;
  status: 'pending' | 'allowed' | 'denied' | 'expired';
  createdAt: string;
}

export interface UsageWindow {
  usedPct: number;
  resetsAt: number; // epoch seconds
}

export interface SessionUsage {
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
  updatedAt: string;
  /** cost/tokens accumulated over earlier segments (counters may reset on resume) */
  priorCostUsd?: number;
  priorInTok?: number;
  priorOutTok?: number;
}

export interface UsageState {
  paused: boolean;
  pausedSource?: string;
  resumesAt?: number;
  warned: boolean;
  plan: { fiveHour?: UsageWindow; sevenDay?: UsageWindow; updatedAt?: string };
  perSession: Record<string, SessionUsage>;
}

export interface Report {
  id: string;
  task: string;
  kind: 'completion' | 'fyi';
  summary: string;
  createdAt: string;
}

export interface PendingEvent {
  id: string; // E<n>
  kind: ChannelKind;
  content: string;
  meta: Record<string, string>;
  pushedAt?: string;
  pushes: number;
  acked: boolean;
  createdAt: string;
}

export type ChannelKind =
  | 'user_decision'
  | 'new_task'
  | 'worker_spawned'
  | 'spawn_failed'
  | 'worker_done'
  | 'permission_request'
  | 'approval_request'
  | 'worker_event'
  | 'system';

export interface AlertState {
  anchor?: string; // time of last alert of any kind
  step: number;
  pendingSince?: string; // coalescing window start
  deadline?: string; // coalescing deadline
  lastAlertItemIds: string[];
}

export interface AppConfig {
  defaultModel?: string;
  hotkey: string;
  coalesceNormalMs: number;
  coalesceUrgentMs: number;
  ladderNormalMin: number[];
  ladderUrgentMin: number[];
  usageWarnPct: number;
  usagePausePct: number;
  ackRedeliverMin: number;
}

export const DEFAULT_CONFIG: AppConfig = {
  hotkey: 'Alt+CommandOrControl+Space',
  coalesceNormalMs: 60_000,
  coalesceUrgentMs: 10_000,
  ladderNormalMin: [15, 30, 60],
  ladderUrgentMin: [5, 10, 15, 30],
  usageWarnPct: 80,
  usagePausePct: 95,
  ackRedeliverMin: 10,
};

export interface Counters {
  T: number;
  W: number;
  A: number;
  R: number;
  P: number;
  G: number;
  E: number;
  RP: number;
}

export interface State {
  seq: number;
  bootId?: string;
  tasks: Record<string, Task>;
  sessions: Record<string, Session>;
  /** worker id -> session id */
  workers: Record<string, string>;
  managerSession?: string;
  attention: Record<string, AttentionItem>;
  grants: Record<string, Grant>;
  approvals: Record<string, ApprovalRequest>;
  permissions: Record<string, PermissionRequest>;
  usage: UsageState;
  reports: Record<string, Report>;
  pending: Record<string, PendingEvent>;
  alert: AlertState;
  counters: Counters;
  config: AppConfig;
  skills: Record<string, { path: string; scope: string; updatedAt: string }>;
  leaks: { at: string; session?: string; kind: string; detail: string }[];
  banners: { id: string; level: 'info' | 'warn' | 'error'; text: string; at: string }[];
}

export function emptyState(): State {
  return {
    seq: 0,
    tasks: {},
    sessions: {},
    workers: {},
    attention: {},
    grants: {},
    approvals: {},
    permissions: {},
    usage: { paused: false, warned: false, plan: {}, perSession: {} },
    reports: {},
    pending: {},
    alert: { step: 0, lastAlertItemIds: [] },
    counters: { T: 0, W: 0, A: 0, R: 0, P: 0, G: 0, E: 0, RP: 0 },
    config: { ...DEFAULT_CONFIG },
    skills: {},
    leaks: [],
    banners: [],
  };
}
