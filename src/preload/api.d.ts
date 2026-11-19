import type { AgentboardApi } from '../shared/ipc';
declare global {
  interface Window {
    agentboard: AgentboardApi;
  }
}
export {};
