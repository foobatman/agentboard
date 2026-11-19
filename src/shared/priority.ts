// Needs-you ordering (SPEC §7.2).
import type { AttentionItem } from './types';

export function attentionScore(a: AttentionItem, now = Date.now()): number {
  const ageH = Math.max(0, (now - Date.parse(a.createdAt)) / 3600_000);
  return (
    (a.urgency === 'urgent' ? 1000 : 0) +
    400 * a.blocks.workers.length +
    100 * a.blocks.tasks.length +
    (a.irreversible ? 50 : 0) +
    Math.min(ageH, 24)
  );
}

export function sortAttention(items: AttentionItem[], now = Date.now()): AttentionItem[] {
  return [...items].sort((x, y) => {
    const d = attentionScore(y, now) - attentionScore(x, now);
    if (Math.abs(d) > 1e-9) return d;
    return Date.parse(x.createdAt) - Date.parse(y.createdAt);
  });
}

export function openItems(all: Record<string, AttentionItem>): AttentionItem[] {
  return Object.values(all).filter((a) => a.status === 'open');
}
export function snoozedItems(all: Record<string, AttentionItem>): AttentionItem[] {
  return Object.values(all).filter((a) => a.status === 'snoozed');
}
