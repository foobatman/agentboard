// Batch-answer grammar (SPEC §7.7, §18.7): "12 yes, 13 no, 14 later 2h, A15 rec, 16 \"use staging\"".
import type { AttentionItem } from './types';

export type ParsedAnswer =
  | { id: string; type: 'option'; optionKey: string }
  | { id: string; type: 'text'; text: string }
  | { id: string; type: 'later'; untilMs: number; label: string };

export interface ParseResult {
  ok: boolean;
  answers: ParsedAnswer[];
  errors: string[];
}

const DURATION_RE = /^(\d+)\s*(m|min|h|hr|d)$/i;

function laterUntil(arg: string | undefined, now: Date): { ms: number; label: string } | string {
  if (!arg) return { ms: now.getTime() + 2 * 3600_000, label: '2h' };
  const a = arg.toLowerCase();
  if (a === 'tomorrow') {
    const t = new Date(now);
    t.setDate(t.getDate() + 1);
    t.setHours(9, 0, 0, 0);
    return { ms: t.getTime(), label: 'tomorrow 09:00' };
  }
  const m = DURATION_RE.exec(a);
  if (!m) return `unknown snooze duration "${arg}"`;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const ms = unit.startsWith('m') ? n * 60_000 : unit.startsWith('h') ? n * 3600_000 : n * 86400_000;
  return { ms: now.getTime() + ms, label: a };
}

export function normaliseId(raw: string): string {
  const m = /^a?(\d+)$/i.exec(raw.trim());
  return m ? `A${m[1]}` : raw.trim();
}

/** Parse a batch answer. Unknown ids/answers make the whole batch invalid (nothing is committed). */
export function parseBatch(input: string, items: Record<string, AttentionItem>, now = new Date()): ParseResult {
  const answers: ParsedAnswer[] = [];
  const errors: string[] = [];
  const parts = input
    .split(/[,;\n]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  for (const part of parts) {
    const m = /^(a?\d+)\s*[:=]?\s*(.*)$/i.exec(part);
    if (!m) {
      errors.push(`cannot parse "${part}" (expected "<id> <answer>")`);
      continue;
    }
    const id = normaliseId(m[1]);
    const rest = m[2].trim();
    const item = items[id];
    if (!item || (item.status !== 'open' && item.status !== 'snoozed')) {
      errors.push(`${id}: no open item with this id`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`${id}: answered twice`);
      continue;
    }
    seen.add(id);
    if (!rest) {
      errors.push(`${id}: missing answer`);
      continue;
    }
    const quoted = /^"(.*)"$/s.exec(rest) ?? /^'(.*)'$/s.exec(rest);
    if (quoted) {
      answers.push({ id, type: 'text', text: quoted[1] });
      continue;
    }
    const [word, arg] = rest.split(/\s+/, 2);
    const w = word.toLowerCase();
    if (w === 'later' || w === 'snooze') {
      const r = laterUntil(arg, now);
      if (typeof r === 'string') errors.push(`${id}: ${r}`);
      else answers.push({ id, type: 'later', untilMs: r.ms, label: r.label });
      continue;
    }
    if (w === 'rec' || w === 'ok' || w === 'recommended') {
      if (!item.recommendation) errors.push(`${id}: has no recommendation`);
      else answers.push({ id, type: 'option', optionKey: item.recommendation.optionKey });
      continue;
    }
    const byKey = item.options.find((o) => o.key.toLowerCase() === rest.toLowerCase());
    const byLabel =
      byKey ?? item.options.find((o) => o.label.toLowerCase() === rest.toLowerCase() || o.label.toLowerCase().split(/[\s,.;:!?()]+/)[0] === w);
    if (byLabel) {
      answers.push({ id, type: 'option', optionKey: byLabel.key });
      continue;
    }
    errors.push(`${id}: "${rest}" is not one of ${item.options.map((o) => `${o.key} (${o.label})`).join(', ')}; use quotes for free text`);
  }
  if (parts.length === 0) errors.push('nothing to answer');
  return { ok: errors.length === 0, answers, errors };
}
