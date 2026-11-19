import { describe, expect, it } from 'vitest';
import { parseBatch } from '../../src/shared/batch';
import { assignName, isValidName, slugify } from '../../src/shared/naming';
import type { AttentionItem } from '../../src/shared/types';

const item = (id: string, extra: Partial<AttentionItem> = {}): AttentionItem => ({
  id, kind: 'decision', origin: 'manager', question: 'q?', options: [{ key: 'a', label: 'Yes' }, { key: 'b', label: 'No' }],
  recommendation: { optionKey: 'a', rationale: 'r' }, irreversible: false, urgency: 'normal',
  blocks: { summary: '', workers: [], tasks: [] }, status: 'open', createdAt: '2026-11-19T10:00:00Z', snoozeCount: 0, deliveredCount: 0, alertCount: 0, ...extra,
});

describe('batch parser', () => {
  const items = { A12: item('A12'), A13: item('A13'), A14: item('A14'), A15: item('A15') };
  it('parses yes/no/later/rec/free text', () => {
    const r = parseBatch('12 yes, 13 no; A14 later 30m\n15 "use staging"', items, new Date('2026-11-19T10:00:00Z'));
    expect(r.ok).toBe(true);
    expect(r.answers).toEqual([
      { id: 'A12', type: 'option', optionKey: 'a' },
      { id: 'A13', type: 'option', optionKey: 'b' },
      { id: 'A14', type: 'later', untilMs: Date.parse('2026-11-19T10:30:00Z'), label: '30m' },
      { id: 'A15', type: 'text', text: 'use staging' },
    ]);
  });
  it('rejects the whole batch on an unknown id', () => {
    const r = parseBatch('12 yes, 99 no', items);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/A99/);
  });
  it('rejects unknown answers', () => {
    expect(parseBatch('12 maybe', items).ok).toBe(false);
    expect(parseBatch('12 rec', items).answers[0]).toEqual({ id: 'A12', type: 'option', optionKey: 'a' });
  });
});

describe('worker naming', () => {
  it('validates and derives meaningful names', () => {
    expect(isValidName('login-tests')).toBe(true);
    expect(isValidName('manager')).toBe(false);
    expect(isValidName('W3')).toBe(false);
    expect(slugify('Add login tests for the auth service')).toBe('login-tests-auth');
    expect(assignName(undefined, 'Research Q3 pricing', new Set()).name).toBe('research-q3-pricing');
  });
  it('dedupes with numeric suffixes', () => {
    expect(assignName('login-tests', 'x', new Set(['login-tests'])).name).toBe('login-tests-2');
    expect(assignName('login-tests', 'x', new Set(['login-tests', 'login-tests-2'])).name).toBe('login-tests-3');
    expect(assignName('Bad Name', 'x', new Set()).error).toBeTruthy();
  });
});
