// Renderer <-> main IPC contract.
import type { SessionUsage, State } from './types';

export interface QuickAddInput {
  title: string;
  description?: string;
  repo?: string;
  kind?: 'code' | 'research' | 'ops' | 'mixed';
  priority?: number;
  escalation?: { preset: 'default' | 'cautious' | 'autonomous' | 'custom'; text?: string };
  preAuthorized?: { action: 'git.push' | 'git.push_branch' | 'git.merge' | 'send_message' | 'deploy' | 'other'; scope: string }[];
}

export interface EnvInfo {
  home: string;
  claudePath?: string;
  claudeVersion?: string;
  versionOk: boolean;
  missingFlags: string[];
  busUrl?: string;
  platform: string;
}

export interface AgentboardApi {
  getState(): Promise<State>;
  getEnv(): Promise<EnvInfo>;
  onState(cb: (s: State) => void): () => void;
  onUsage(cb: (session: string, u: SessionUsage) => void): () => void;
  onNavigate(cb: (view: string) => void): () => void;
  liveUsage(): Promise<Record<string, SessionUsage>>;
  ptyReplay(session: string): Promise<string>;
  ptyInput(session: string, data: string): void;
  ptyResize(session: string, cols: number, rows: number): void;
  onPtyData(cb: (session: string, data: string) => void): () => void;
  addTask(input: QuickAddInput): Promise<string>;
  previewBatch(text: string): Promise<{ ok: boolean; errors: string[]; answers: unknown[] }>;
  answerBatch(text: string): Promise<{ ok: boolean; errors: string[]; answered: string[]; snoozed: string[] }>;
  answer(id: string, optionKey?: string, text?: string): Promise<void>;
  snooze(id: string, minutes: number): Promise<void>;
  cancelTask(id: string): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  restartSession(session: string): Promise<void>;
  stopSession(session: string): Promise<void>;
  copyResumeCommand(session: string): Promise<string>;
  openPath(p: string): Promise<void>;
}

export const IPC = {
  getState: 'ab:getState',
  getEnv: 'ab:getEnv',
  state: 'ab:state',
  usage: 'ab:usage',
  navigate: 'ab:navigate',
  liveUsage: 'ab:liveUsage',
  ptyReplay: 'ab:ptyReplay',
  ptyInput: 'ab:ptyInput',
  ptyResize: 'ab:ptyResize',
  ptyData: 'ab:ptyData',
  addTask: 'ab:addTask',
  previewBatch: 'ab:previewBatch',
  answerBatch: 'ab:answerBatch',
  answer: 'ab:answer',
  snooze: 'ab:snooze',
  cancelTask: 'ab:cancelTask',
  setPaused: 'ab:setPaused',
  restartSession: 'ab:restartSession',
  stopSession: 'ab:stopSession',
  copyResumeCommand: 'ab:copyResumeCommand',
  openPath: 'ab:openPath',
} as const;
