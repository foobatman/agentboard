import { useMemo, useState } from 'react';
import { sortAttention } from '../../shared/priority';
import type { AttentionItem } from '../../shared/types';
import { useStore } from '../store';

function age(iso: string): string {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

function Card({ a }: { a: AttentionItem }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`card att ${a.urgency === 'urgent' ? 'urgent' : ''}`}>
      <div className="att-head">
        <span className="id">{a.urgency === 'urgent' ? '‼ ' : ''}{a.id}</span>
        <span>{a.task}</span>
        {a.workerName && <span className="muted">· {a.workerName}</span>}
        {a.irreversible && <span className="tag danger">IRREVERSIBLE</span>}
        {a.urgency === 'urgent' && <span className="tag warn">URGENT</span>}
        {a.origin === 'app' && <span className="tag">agentboard</span>}
        <span className="muted right">open {age(a.createdAt)}{a.status === 'snoozed' && a.snoozeUntil ? ` · later until ${new Date(a.snoozeUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</span>
      </div>
      <div className="question">{a.question}</div>
      {a.recommendation && (
        <div className="rec">
          Manager recommends <b>{a.options.find((o) => o.key === a.recommendation!.optionKey)?.label ?? a.recommendation.optionKey}</b> — {a.recommendation.rationale}
        </div>
      )}
      {a.blocks.summary && <div className="muted small">Blocks: {a.blocks.summary}</div>}
      {a.detail && (
        <div className="small">
          <button className="link" onClick={() => setMore(!more)}>{more ? 'Hide details' : 'Details'}</button>
          {more && <pre className="detail">{a.detail}</pre>}
        </div>
      )}
      <div className="options">
        {a.options.map((o) => (
          <button key={o.key} disabled={busy} className={o.key === a.recommendation?.optionKey ? 'primary' : ''} title={o.consequence} onClick={() => act(() => window.agentboard.answer(a.id, o.key))}>
            {o.key}: {o.label}
          </button>
        ))}
        <input placeholder="or type an answer…" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && text.trim() && act(() => window.agentboard.answer(a.id, undefined, text.trim()))} />
        <select disabled={busy} value="" onChange={(e) => e.target.value && act(() => window.agentboard.snooze(a.id, Number(e.target.value)))}>
          <option value="">Later…</option>
          <option value="30">30 min</option>
          <option value="120">2 h</option>
          <option value={String(Math.max(30, Math.round((new Date(new Date().setHours(33, 0, 0, 0)).getTime() - Date.now()) / 60000)))}>tomorrow 09:00</option>
        </select>
      </div>
    </div>
  );
}

export function NeedsYou() {
  const attention = useStore((s) => s.state.attention);
  const [batch, setBatch] = useState('');
  const [preview, setPreview] = useState<{ ok: boolean; errors: string[]; answers: unknown[] } | undefined>();
  const [msg, setMsg] = useState('');
  const items = Object.values(attention);
  const open = useMemo(() => sortAttention(items.filter((a) => a.status === 'open')), [attention]);
  const later = items.filter((a) => a.status === 'snoozed');
  const history = items
    .filter((a) => ['answered', 'applied', 'withdrawn'].includes(a.status) && Date.now() - Date.parse(a.answer?.at ?? a.createdAt) < 86400_000)
    .sort((x, y) => (y.answer?.at ?? y.createdAt).localeCompare(x.answer?.at ?? x.createdAt));
  const urgent = open.filter((a) => a.urgency === 'urgent').length;

  const acceptRecs = async () => {
    const lines = open.filter((a) => a.recommendation && !a.irreversible).map((a) => `${a.id} rec`);
    if (!lines.length) return;
    const r = await window.agentboard.answerBatch(lines.join(', '));
    setMsg(r.ok ? `Accepted recommendations for ${r.answered.join(', ')}` : r.errors.join('; '));
  };

  return (
    <div className="page">
      <div className="page-head">
        <h2>Needs you — {open.length} open{urgent ? ` (${urgent} urgent)` : ''}{later.length ? ` · ${later.length} later` : ''}</h2>
        <button onClick={acceptRecs} title="Irreversible items always need an explicit answer">Accept recommendations (non-irreversible)</button>
      </div>
      <div className="batch">
        <input
          placeholder='Answer in one go: 12 yes, 13 no, 14 later 2h, 15 "use staging"'
          value={batch}
          onChange={async (e) => {
            setBatch(e.target.value);
            setMsg('');
            setPreview(e.target.value.trim() ? await window.agentboard.previewBatch(e.target.value) : undefined);
          }}
          onKeyDown={async (e) => {
            if (e.key !== 'Enter' || !preview?.ok) return;
            const r = await window.agentboard.answerBatch(batch);
            if (r.ok) {
              setBatch('');
              setPreview(undefined);
              setMsg(`Answered ${r.answered.join(', ') || 'none'}${r.snoozed.length ? `; later: ${r.snoozed.join(', ')}` : ''}`);
            } else setMsg(r.errors.join('; '));
          }}
        />
        {preview && (
          <div className={`preview ${preview.ok ? 'ok' : 'bad'}`}>
            {preview.ok
              ? `Press Enter to send: ${(preview.answers as { id: string; type: string; optionKey?: string; label?: string; text?: string }[]).map((a) => `${a.id} → ${a.type === 'later' ? `later (${a.label})` : a.optionKey ?? `"${a.text}"`}`).join(', ')}`
              : preview.errors.join(' · ')}
          </div>
        )}
        {msg && <div className="muted small">{msg}</div>}
      </div>
      {open.length === 0 && <div className="empty">Nothing needs you right now.</div>}
      {open.map((a) => (
        <Card key={a.id} a={a} />
      ))}
      {later.length > 0 && (
        <>
          <h3>Later ({later.length})</h3>
          {later.map((a) => (
            <Card key={a.id} a={a} />
          ))}
        </>
      )}
      {history.length > 0 && (
        <>
          <h3>History (24 h)</h3>
          <table className="list">
            <tbody>
              {history.map((a) => (
                <tr key={a.id}>
                  <td>{a.id}</td>
                  <td>{a.task}</td>
                  <td>{a.question}</td>
                  <td>{a.status === 'withdrawn' ? `withdrawn (${a.withdrawnReason})` : `${a.answer?.optionKey ?? `"${a.answer?.text}"`} · ${a.status}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
