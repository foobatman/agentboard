import { create } from 'zustand';
import type { EnvInfo } from '../shared/ipc';
import { emptyState, type SessionUsage, type State } from '../shared/types';

export type View = { kind: 'session'; id: string } | { kind: 'needs' } | { kind: 'board' } | { kind: 'reports' };

interface Store {
  state: State;
  env?: EnvInfo;
  live: Record<string, SessionUsage>;
  view: View;
  openTabs: string[];
  quickAdd: boolean;
  usageDrawer?: string;
  setView(v: View): void;
  setQuickAdd(v: boolean): void;
  setUsageDrawer(s?: string): void;
}

export const useStore = create<Store>((set, get) => ({
  state: emptyState(),
  live: {},
  view: { kind: 'needs' },
  openTabs: [],
  quickAdd: false,
  setView: (v) => {
    if (v.kind === 'session' && !get().openTabs.includes(v.id)) set({ openTabs: [...get().openTabs, v.id] });
    set({ view: v });
  },
  setQuickAdd: (v) => set({ quickAdd: v }),
  setUsageDrawer: (s) => set({ usageDrawer: s }),
}));

export function initStore(): void {
  const api = window.agentboard;
  void api.getState().then((s) => {
    useStore.setState({ state: s });
    if (s.managerSession) useStore.getState().setView({ kind: 'session', id: s.managerSession });
  });
  void api.getEnv().then((env) => useStore.setState({ env }));
  void api.liveUsage().then((live) => useStore.setState({ live }));
  api.onState((s) => useStore.setState({ state: s }));
  api.onUsage((session, u) => useStore.setState({ live: { ...useStore.getState().live, [session]: u } }));
  api.onNavigate((v) => {
    const st = useStore.getState();
    if (v === 'quickadd') st.setQuickAdd(true);
    else if (v === 'needs') st.setView({ kind: 'needs' });
    else if (v === 'board') st.setView({ kind: 'board' });
    else if (v === 'manager' && st.state.managerSession) st.setView({ kind: 'session', id: st.state.managerSession });
  });
}

export function usageFor(sessionId: string): SessionUsage | undefined {
  const { live, state } = useStore.getState();
  return live[sessionId] ?? state.usage.perSession[sessionId];
}
