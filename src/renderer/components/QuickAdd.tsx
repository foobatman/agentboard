import { useEffect, useRef, useState } from 'react';
import type { QuickAddInput } from '../../shared/ipc';
import { useStore } from '../store';

type Preset = NonNullable<QuickAddInput['escalation']>['preset'];
const PREAUTH: { action: NonNullable<QuickAddInput['preAuthorized']>[number]['action']; label: string }[] = [
  { action: 'git.push_branch', label: 'Push the task branch' },
  { action: 'git.merge', label: 'Merge to base branch' },
  { action: 'git.push', label: 'Push base branch' },
  { action: 'send_message', label: 'Send email / messages' },
  { action: 'deploy', label: 'Deploy' },
];

export function QuickAdd() {
  const show = useStore((s) => s.quickAdd);
  const close = () => useStore.getState().setQuickAdd(false);
  const [text, setText] = useState('');
  const [repo, setRepo] = useState('');
  const [kind, setKind] = useState<'' | 'code' | 'research' | 'ops' | 'mixed'>('');
  const [priority, setPriority] = useState(3);
  const [preset, setPreset] = useState<Preset>('default');
  const [policy, setPolicy] = useState('');
  const [pre, setPre] = useState<Set<string>>(new Set());
  const [err, setErr] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (show) setTimeout(() => ref.current?.focus(), 30);
  }, [show]);
  if (!show) return null;
  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    const [title, ...rest] = t.split('\n');
    try {
      await window.agentboard.addTask({
        title: title.slice(0, 200),
        description: rest.join('\n').trim() || title,
        repo: repo.trim() || undefined,
        kind: kind || undefined,
        priority,
        escalation: { preset, text: policy.trim() || undefined },
        preAuthorized: [...pre].map((action) => ({ action: action as never, scope: 'this task only' })),
      });
      setText('');
      setPolicy('');
      setPre(new Set());
      setErr('');
      close();
    } catch (e) {
      setErr(String(e));
    }
  };
  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') close(); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(); }}>
        <h3>New task for the manager</h3>
        <textarea ref={ref} rows={5} placeholder={'First line = title. Then details, constraints, definition of done…'} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="row">
          <label>Repo / folder <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="optional: /path/to/repo or repos.json key" /></label>
          <label>Kind <select value={kind} onChange={(e) => setKind(e.target.value as never)}><option value="">auto</option><option value="code">code</option><option value="research">research</option><option value="ops">ops</option><option value="mixed">mixed</option></select></label>
          <label>Priority <select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>{[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>P{p}</option>)}</select></label>
        </div>
        <div className="row">
          <label>Escalation
            <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
              <option value="default">default — irreversible + stuck</option>
              <option value="cautious">cautious — also design choices</option>
              <option value="autonomous">autonomous — only the hard floor</option>
              <option value="custom">custom</option>
            </select>
          </label>
          <label className="grow">How should the manager handle decisions on this task? <input value={policy} onChange={(e) => setPolicy(e.target.value)} placeholder='e.g. "ask me before changing the public API"' /></label>
        </div>
        <div className="row preauth">
          <span className="muted">Pre-authorise (skips asking you):</span>
          {PREAUTH.map((p) => (
            <label key={p.action} className="check">
              <input type="checkbox" checked={pre.has(p.action)} onChange={(e) => { const n = new Set(pre); if (e.target.checked) n.add(p.action); else n.delete(p.action); setPre(n); }} /> {p.label}
            </label>
          ))}
        </div>
        {err && <div className="error">{err}</div>}
        <div className="row end">
          <span className="muted small">⌘↩ to add · Esc to cancel</span>
          <button onClick={close}>Cancel</button>
          <button className="primary" onClick={() => void submit()}>Add task</button>
        </div>
      </div>
    </div>
  );
}
