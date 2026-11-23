import { useEffect } from 'react';
import { LIVE_SESSION_STATES, type Session, type TaskStatus } from '../shared/types';
import { initStore, useStore } from './store';
import { TerminalView } from './components/Terminal';
import { Bar, UsageChip, UsageDrawer, useUsage } from './components/Usage';
import { NeedsYou } from './components/NeedsYou';
import { Board, Reports } from './components/Board';
import { QuickAdd } from './components/QuickAdd';

function SessionRow({ s }: { s: Session }) {
  const view = useStore((x) => x.view);
  const setView = useStore((x) => x.setView);
  const u = useUsage(s.id);
  const taskTitle = useStore((x) => (s.taskId ? x.state.tasks[s.taskId]?.title : undefined));
  const active = view.kind === 'session' && view.id === s.id;
  return (
    <div className={`nav-item ${active ? 'active' : ''}`} onClick={() => setView({ kind: 'session', id: s.id })} title={`${s.name} · ${s.state}${s.taskId ? ` · ${s.taskId}` : ''}`}>
      <span className={`dot ${s.state}`} />
      <span className="text">
        <span className="name">{s.role === 'manager' ? 'Manager' : s.name}</span>
        <span className="sub">{[taskTitle ? `${s.taskId} · ${taskTitle}` : s.taskId, s.state.replace(/_/g, ' ')].filter(Boolean).join(' · ')}</span>
      </span>
      <Bar pct={u?.ctxUsedPct} />
    </div>
  );
}

/** Task states where the worker's job is over (failed stays visible: it usually needs you). */
const FINISHED_TASK_STATUSES: TaskStatus[] = ['review', 'done', 'cancelled'];

function Sidebar() {
  const st = useStore((x) => x.state);
  const view = useStore((x) => x.view);
  const setView = useStore((x) => x.setView);
  const open = Object.values(st.attention).filter((a) => a.status === 'open');
  const urgent = open.filter((a) => a.urgency === 'urgent').length;
  const mgr = st.managerSession ? st.sessions[st.managerSession] : undefined;
  const workers = Object.values(st.sessions)
    .filter((s) => s.role === 'worker' && !s.cleanedUp && (LIVE_SESSION_STATES.includes(s.state) || ['crashed', 'interrupted', 'exited'].includes(s.state)))
    .sort((a, b) => (a.taskId ?? '').localeCompare(b.taskId ?? '', undefined, { numeric: true }));
  const hideFinished = useStore((x) => x.hideFinishedWorkers);
  const setHideFinished = useStore((x) => x.setHideFinishedWorkers);
  const isFinished = (s: Session) => {
    const status = s.taskId ? st.tasks[s.taskId]?.status : undefined;
    return !!status && FINISHED_TASK_STATUSES.includes(status);
  };
  const finishedCount = workers.filter(isFinished).length;
  // Keep the worker you are looking at in the list even when it is finished.
  const shownWorkers = hideFinished ? workers.filter((w) => !isFinished(w) || (view.kind === 'session' && view.id === w.id)) : workers;
  const p = st.usage.plan;
  return (
    <aside className="sidebar">
      <div className="brand">agentboard</div>
      {mgr && <SessionRow s={mgr} />}
      <div className={`nav-item ${view.kind === 'needs' ? 'active' : ''}`} onClick={() => setView({ kind: 'needs' })}>
        <span className="icon">⚑</span>
        <span className="name">Needs you</span>
        {open.length > 0 && <span className={`count ${urgent ? 'urgent' : ''}`}>{open.length}{urgent ? ` · ${urgent}‼` : ''}</span>}
      </div>
      <div className={`nav-item ${view.kind === 'board' ? 'active' : ''}`} onClick={() => setView({ kind: 'board' })}>
        <span className="icon">▦</span>
        <span className="name">Board</span>
      </div>
      <div className={`nav-item ${view.kind === 'reports' ? 'active' : ''}`} onClick={() => setView({ kind: 'reports' })}>
        <span className="icon">✎</span>
        <span className="name">Reports</span>
      </div>
      <div className="section section-row">
        <span>WORKERS</span>
        {finishedCount > 0 && (
          <button
            className="link small"
            onClick={() => setHideFinished(!hideFinished)}
            title={hideFinished ? 'Show workers whose task is in review, done or cancelled' : 'Hide workers whose task is in review, done or cancelled'}
          >
            {hideFinished ? `Show finished (${finishedCount})` : 'Hide finished'}
          </button>
        )}
      </div>
      {workers.length === 0 && <div className="muted small pad">No workers yet</div>}
      {workers.length > 0 && shownWorkers.length === 0 && <div className="muted small pad">All workers finished</div>}
      {shownWorkers.map((w) => (
        <SessionRow key={w.id} s={w} />
      ))}
      <div className="spacer" />
      <div className="plan">
        <div title={p.fiveHour ? `resets ${new Date(p.fiveHour.resetsAt * 1000).toLocaleTimeString()}` : 'appears after the first response (Pro/Max only)'}>
          5h <Bar pct={p.fiveHour?.usedPct} warn={st.config.usageWarnPct} danger={st.config.usagePausePct} /> {p.fiveHour ? `${Math.round(p.fiveHour.usedPct)}%` : '—'}
        </div>
        <div>
          7d <Bar pct={p.sevenDay?.usedPct} warn={st.config.usageWarnPct} danger={st.config.usagePausePct} /> {p.sevenDay ? `${Math.round(p.sevenDay.usedPct)}%` : '—'}
        </div>
        <button className={`small ${st.usage.paused ? 'warn' : ''}`} onClick={() => void window.agentboard.setPaused(!st.usage.paused)}>
          {st.usage.paused ? `Spawning paused (${st.usage.pausedSource}) — resume` : 'Pause spawning'}
        </button>
      </div>
    </aside>
  );
}

function SessionHeader({ id }: { id: string }) {
  const s = useStore((x) => x.state.sessions[id]);
  const task = useStore((x) => (s?.taskId ? x.state.tasks[s.taskId] : undefined));
  if (!s) return null;
  const live = LIVE_SESSION_STATES.includes(s.state);
  return (
    <div className="session-head">
      <span className={`dot ${s.state}`} />
      <strong>{s.role === 'manager' ? 'Manager' : s.name}</strong>
      {task && <span className="muted"> · {task.id} {task.title}</span>}
      <span className="muted"> · {s.state}</span>
      <UsageChip session={id} />
      <span className="spacer" />
      {s.role === 'worker' && <span className="muted small">Managed by the manager — you can peek or type; the manager won’t see what you type.</span>}
      <button className="small" onClick={() => void window.agentboard.copyResumeCommand(id)} title="Copy a claude --resume command for another terminal">Copy resume cmd</button>
      {!live && <button className="small" onClick={() => void window.agentboard.restartSession(id)}>Resume</button>}
      {live && s.role === 'worker' && <button className="small" onClick={() => confirm(`Stop ${s.name}?`) && void window.agentboard.stopSession(id)}>Stop</button>}
    </div>
  );
}

function Banners() {
  const banners = useStore((x) => x.state.banners);
  const env = useStore((x) => x.env);
  const allLeaks = useStore((x) => x.state.leaks);
  const leaks = allLeaks.filter((l) => Date.now() - Date.parse(l.at) < 3600_000 && l.kind !== 'sendmessage_unverified');
  return (
    <>
      {banners.map((b) => (
        <div key={b.id} className={`banner ${b.level}`}>{b.text}</div>
      ))}
      {env && !env.claudePath && <div className="banner error">claude CLI not found.</div>}
      {leaks.length > 0 && <div className="banner warn">Blocked {leaks.length} attempt(s) by a session to notify you or act outside the rules in the last hour (latest: {leaks[leaks.length - 1].detail}).</div>}
    </>
  );
}

export function App() {
  useEffect(() => initStore(), []);
  const view = useStore((x) => x.view);
  const tabs = useStore((x) => x.openTabs);
  const sessions = useStore((x) => x.state.sessions);
  const setQuickAdd = useStore((x) => x.setQuickAdd);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setQuickAdd(true);
      }
    };
    window.addEventListener('keydown', h, true); // capture: the focused terminal must not swallow it
    return () => window.removeEventListener('keydown', h, true);
  }, [setQuickAdd]);
  return (
    <div className="app">
      <Sidebar />
      <main>
        <Banners />
        {view.kind === 'session' && <SessionHeader id={view.id} />}
        <div className="content">
          {tabs.filter((t) => sessions[t]).map((t) => (
            <TerminalView key={t} session={t} visible={view.kind === 'session' && view.id === t} />
          ))}
          {view.kind === 'needs' && <NeedsYou />}
          {view.kind === 'board' && <Board />}
          {view.kind === 'reports' && <Reports />}
        </div>
      </main>
      <QuickAdd />
      <UsageDrawer />
    </div>
  );
}
