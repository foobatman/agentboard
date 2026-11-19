import type { SessionUsage, UsageWindow } from '../../shared/types';
import { useStore } from '../store';

export function fmtTok(n?: number): string {
  if (n === undefined) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}
function fmtMs(ms?: number): string {
  if (ms === undefined) return '—';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}
function resetAt(w?: UsageWindow): string {
  if (!w?.resetsAt) return '';
  const d = new Date(w.resetsAt * 1000);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}
const cost = (u?: SessionUsage) => (u?.costUsd === undefined ? undefined : u.costUsd + (u.priorCostUsd ?? 0));
const tokens = (u?: SessionUsage) => (u && (u.inTok !== undefined || u.outTok !== undefined) ? (u.inTok ?? 0) + (u.outTok ?? 0) + (u.priorInTok ?? 0) + (u.priorOutTok ?? 0) : undefined);

export function useUsage(session?: string): SessionUsage | undefined {
  const live = useStore((s) => (session ? s.live[session] : undefined));
  const persisted = useStore((s) => (session ? s.state.usage.perSession[session] : undefined));
  return live ?? persisted;
}

export function Bar({ pct, warn = 80, danger = 95 }: { pct?: number | null; warn?: number; danger?: number }) {
  const p = Math.max(0, Math.min(100, pct ?? 0));
  const cls = p >= danger ? 'danger' : p >= warn ? 'warn' : '';
  return (
    <span className="bar" title={pct == null ? 'no data yet' : `${Math.round(p)}%`}>
      <span className={`fill ${cls}`} style={{ width: `${p}%` }} />
    </span>
  );
}

/** Compact chip shown above every terminal (SPEC §6.10, §11.2). */
export function UsageChip({ session }: { session: string }) {
  const u = useUsage(session);
  const plan = useStore((s) => s.state.usage.plan);
  const open = useStore((s) => s.setUsageDrawer);
  const c = cost(u);
  return (
    <button className="usage-chip" onClick={() => open(session)} title="Usage reported by this Claude session (click for details)">
      <span>ctx {u?.ctxUsedPct == null ? '—' : `${Math.round(u.ctxUsedPct)}%`}</span>
      <span>· {fmtTok(tokens(u))} tok</span>
      {c !== undefined && <span>· ~${c.toFixed(2)} est</span>}
      <span>· 5h {plan.fiveHour ? `${Math.round(plan.fiveHour.usedPct)}%` : '—'}</span>
    </button>
  );
}

export function UsageDrawer() {
  const session = useStore((s) => s.usageDrawer);
  const close = useStore((s) => s.setUsageDrawer);
  const sess = useStore((s) => (session ? s.state.sessions[session] : undefined));
  const plan = useStore((s) => s.state.usage.plan);
  const u = useUsage(session);
  if (!session || !sess) return null;
  const c = cost(u);
  return (
    <div className="drawer-backdrop" onClick={() => close(undefined)}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <strong>Usage — {sess.name}</strong>
          {sess.taskId && <span className="muted"> · {sess.taskId}</span>}
          <span className="muted"> · {u?.model ?? 'model unknown'}</span>
          <button className="x" onClick={() => close(undefined)}>×</button>
        </div>
        <table className="kv">
          <tbody>
            <tr>
              <th>Context</th>
              <td>
                <Bar pct={u?.ctxUsedPct} /> {u?.ctxUsedPct == null ? 'waiting for first response' : `${Math.round(u.ctxUsedPct)}% of ${fmtTok(u.ctxSize)}`}
              </td>
            </tr>
            <tr>
              <th>Tokens</th>
              <td>
                total {fmtTok(tokens(u))} · in {fmtTok(u?.inTok)} · out {fmtTok(u?.outTok)}
                {u?.cur && ` · last call: cache read ${fmtTok(u.cur.cacheRead)}, cache write ${fmtTok(u.cur.cacheCreate)}`}
              </td>
            </tr>
            <tr>
              <th>Cost (est.)</th>
              <td>{c === undefined ? '—' : `$${c.toFixed(2)}`} <span className="muted">API list-price equivalent — not what Max/Pro bills</span></td>
            </tr>
            <tr>
              <th>Time</th>
              <td>API {fmtMs(u?.apiMs)} · wall {fmtMs(u?.durationMs)}</td>
            </tr>
            <tr>
              <th>Code</th>
              <td>+{u?.linesAdded ?? 0} / −{u?.linesRemoved ?? 0} lines</td>
            </tr>
            <tr>
              <th>Plan (account-wide)</th>
              <td>
                {plan.fiveHour || plan.sevenDay ? (
                  <>
                    5-hour <Bar pct={plan.fiveHour?.usedPct} /> {plan.fiveHour ? `${Math.round(plan.fiveHour.usedPct)}% · resets ${resetAt(plan.fiveHour)}` : '—'}
                    <br />
                    7-day <Bar pct={plan.sevenDay?.usedPct} /> {plan.sevenDay ? `${Math.round(plan.sevenDay.usedPct)}% · resets ${resetAt(plan.sevenDay)}` : '—'}
                  </>
                ) : (
                  <span className="muted">appears after the first response, and only with a Pro/Max/Ultra login</span>
                )}
              </td>
            </tr>
          </tbody>
        </table>
        <p className="muted small">Source: this session’s Claude Code statusLine feed. Claude Code exposes no per-session plan-credit figure; plan windows are shared by all sessions.</p>
      </div>
    </div>
  );
}
