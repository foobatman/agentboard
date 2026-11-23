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
  /** Sidebar: hide workers whose task is finished (persisted per machine). */
  hideFinishedWorkers: boolean;
  setView(v: View): void;
  setHideFinishedWorkers(v: boolean): void;
  setQuickAdd(v: boolean): void;
  setUsageDrawer(s?: string): void;
}

const HIDE_FINISHED_KEY = 'agentboard.hideFinishedWorkers';
function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export const useStore = create<Store>((set, get) => ({
  state: emptyState(),
  live: {},
  view: { kind: 'needs' },
  openTabs: [],
  quickAdd: false,
  hideFinishedWorkers: loadFlag(HIDE_FINISHED_KEY),
  setHideFinishedWorkers: (v) => {
    try {
      localStorage.setItem(HIDE_FINISHED_KEY, v ? '1' : '0');
    } catch {
      /* storage unavailable: keep the choice for this run only */
    }
    set({ hideFinishedWorkers: v });
  },
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
