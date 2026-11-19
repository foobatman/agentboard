import { useState } from 'react';
import type { Task, TaskStatus } from '../../shared/types';
import { useStore } from '../store';
import { Bar, useUsage } from './Usage';

const COLUMNS: { title: string; statuses: TaskStatus[] }[] = [
  { title: 'Inbox', statuses: ['inbox'] },
  { title: 'Planned / Queued', statuses: ['planned', 'queued'] },
  { title: 'Running', statuses: ['running'] },
  { title: 'Blocked', statuses: ['blocked'] },
  { title: 'Review', statuses: ['review'] },
  { title: 'Done', statuses: ['done'] },
  { title: 'Failed / Cancelled', statuses: ['failed', 'cancelled'] },
];

function TaskCard({ t, onOpen }: { t: Task; onOpen: () => void }) {
  const sessions = useStore((s) => s.state.sessions);
  const workers = useStore((s) => s.state.workers);
  const attention = useStore((s) => s.state.attention);
  const sess = t.worker ? sessions[workers[t.worker]] : undefined;
  const u = useUsage(sess?.id);
  const blocking = Object.values(attention).filter((a) => (a.status === 'open' || a.status === 'snoozed') && a.task === t.id).length;
  const cost = u?.costUsd !== undefined ? u.costUsd + (u.priorCostUsd ?? 0) : undefined;
  return (
    <div className="card task" onClick={onOpen}>
      <div className="task-head">
        <span className="id">{t.id}</span> {t.title}
      </div>
      {sess && (
        <div className="small">
          <span className={`dot ${sess.state}`} /> {sess.name} <span className="muted">· {sess.state}</span>
        </div>
      )}
      {t.lastProgress && <div className="small muted">{t.lastProgress.summary}</div>}
      {t.branch && <div className="small mono">{t.branch}</div>}
      <div className="small">
        {u && <Bar pct={u.ctxUsedPct} />} {cost !== undefined && <span className="muted">~${cost.toFixed(2)}</span>} {blocking > 0 && <span className="tag warn">needs you ({blocking})</span>}
      </div>
    </div>
  );
}

export function Board() {
  const tasks = useStore((s) => s.state.tasks);
  const reports = useStore((s) => s.state.reports);
  const setQuickAdd = useStore((s) => s.setQuickAdd);
  const setView = useStore((s) => s.setView);
  const workers = useStore((s) => s.state.workers);
  const [open, setOpen] = useState<string>();
  const t = open ? tasks[open] : undefined;
  return (
    <div className="page board-page">
      <div className="page-head">
        <h2>Board</h2>
        <button className="primary" onClick={() => setQuickAdd(true)}>+ Add task</button>
      </div>
      <div className="kanban">
        {COLUMNS.map((c) => {
          const list = Object.values(tasks)
            .filter((x) => c.statuses.includes(x.status))
            .sort((a, b) => a.priority - b.priority || b.updatedAt.localeCompare(a.updatedAt))
            .slice(0, c.title === 'Done' ? 30 : 200);
          return (
            <div className="column" key={c.title}>
              <div className="col-head">
                {c.title} <span className="muted">{list.length}</span>
              </div>
              {list.map((x) => (
                <TaskCard key={x.id} t={x} onOpen={() => setOpen(x.id)} />
              ))}
            </div>
          );
        })}
      </div>
      {t && (
        <div className="drawer-backdrop" onClick={() => setOpen(undefined)}>
          <div className="drawer wide" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <strong>
                {t.id} · {t.title}
              </strong>
              <span className="muted"> · {t.status} · {t.kind} · P{t.priority}</span>
              <button className="x" onClick={() => setOpen(undefined)}>×</button>
            </div>
            <p className="pre">{t.description}</p>
            <table className="kv">
              <tbody>
                <tr><th>Escalation</th><td>{t.escalation.preset}{t.escalation.text ? ` — ${t.escalation.text}` : ''}{t.escalation.rules?.length ? ` (${t.escalation.rules.length} rules)` : ''}</td></tr>
                {t.preAuthorized.length > 0 && <tr><th>Pre-authorised</th><td>{t.preAuthorized.map((p) => `${p.action}${p.executed ? ' (used)' : ''}`).join(', ')}</td></tr>}
                {t.repo && <tr><th>Repo</th><td className="mono">{t.repo}{t.baseBranch ? ` @ ${t.baseBranch}` : ''}</td></tr>}
                {(t.branch || t.workspace) && <tr><th>Branch / workspace</th><td className="mono">{t.branch ?? t.workspace}</td></tr>}
                {t.outcome && <tr><th>Outcome</th><td>{t.outcome.outcome}: {t.outcome.summary}<br /><span className="muted">Verification: {t.outcome.verification}</span></td></tr>}
              </tbody>
            </table>
            {Object.values(reports).filter((r) => r.task === t.id).map((r) => (
              <div className="report" key={r.id}><div className="muted small">{r.kind} · {new Date(r.createdAt).toLocaleString()}</div><div className="pre">{r.summary}</div></div>
            ))}
            <div className="row">
              {t.worker && workers[t.worker] && <button onClick={() => { setView({ kind: 'session', id: workers[t.worker!] }); setOpen(undefined); }}>Open terminal</button>}
              {!['done', 'failed', 'cancelled'].includes(t.status) && (
                <button className="danger" onClick={() => { if (confirm(`Cancel ${t.id}? Its worker will be stopped.`)) void window.agentboard.cancelTask(t.id); }}>Cancel task</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function Reports() {
  const reports = useStore((s) => s.state.reports);
  const tasks = useStore((s) => s.state.tasks);
  const list = Object.values(reports).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <div className="page">
      <div className="page-head"><h2>Reports</h2></div>
      {list.length === 0 && <div className="empty">The manager hasn’t reported anything yet.</div>}
      {list.map((r) => (
        <div className="card" key={r.id}>
          <div className="muted small">{r.id} · {r.task} {tasks[r.task]?.title} · {r.kind} · {new Date(r.createdAt).toLocaleString()}</div>
          <div className="pre">{r.summary}</div>
        </div>
      ))}
    </div>
  );
}
