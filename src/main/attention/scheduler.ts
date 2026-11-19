import { ulid } from 'ulid';
import { APP, draft } from '../../shared/events';
import { sortAttention } from '../../shared/priority';
import type { AttentionItem, State } from '../../shared/types';
import type { StateHub } from '../store/state-hub';
import type { NotificationService } from '../notify/notification-service';

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

const RETRY_MS = [30_000, 120_000, 300_000];
const BOOT_DELAY_MS = 3_000;

export function summarise(state: State, kind: 'first' | 'new' | 'reminder' | 'boot', now: number): { title: string; body: string; urgent: boolean } {
  const open = sortAttention(Object.values(state.attention).filter((a) => a.status === 'open'), now);
  const snoozed = Object.values(state.attention).filter((a) => a.status === 'snoozed').length;
  const urgent = open.filter((a) => a.urgency === 'urgent').length;
  const n = open.length;
  const head = `${n} item${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you${urgent ? ` (${urgent} urgent)` : ''}`;
  const newCount = open.filter((a) => !a.alertedAt).length;
  const prefix = kind === 'new' && newCount > 0 && newCount < n ? `${newCount} new · ` : kind === 'boot' ? 'Still open: ' : '';
  const oldest = open.reduce((m, a) => Math.min(m, Date.parse(a.createdAt)), now);
  const ageMin = Math.round((now - oldest) / 60000);
  const top = open
    .slice(0, 3)
    .map((a) => `${a.id}: ${a.question}`)
    .join(' · ');
  const tail = [snoozed ? `${snoozed} later` : '', kind === 'reminder' && ageMin > 0 ? `oldest ${ageMin}m` : ''].filter(Boolean).join(', ');
  return { title: 'agentboard', body: `${prefix}${head}${tail ? ` — ${tail}` : ''}. ${top}`, urgent: urgent > 0 };
}

/**
 * Coalescing window + reminder ladder + snooze expiry + boot re-alert (SPEC §7.3–7.8, §18.7).
 * Invariant: an alert is only sent for items already persisted; `attention.alerted` is committed
 * after the OS call returns.
 */
export class AttentionScheduler {
  private timer: unknown;
  private windowStart?: number;
  private deadline?: number;
  private bootPendingUntil?: number;
  private retryIdx = 0;
  private retryAt?: number;
  private busy = false;
  private stopped = false;

  constructor(
    private readonly hub: StateHub,
    private readonly notify: NotificationService,
    private readonly clock: Clock = realClock,
  ) {}

  start(isBoot: boolean): void {
    this.hub.on('events', () => this.schedule());
    if (isBoot && this.openItems().length > 0) this.bootPendingUntil = this.clock.now() + BOOT_DELAY_MS;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) this.clock.clearTimeout(this.timer);
  }

  private openItems(): AttentionItem[] {
    return Object.values(this.hub.state.attention).filter((a) => a.status === 'open');
  }

  private ladderMs(): number {
    const cfg = this.hub.state.config;
    const anyUrgent = this.openItems().some((a) => a.urgency === 'urgent');
    const ladder = anyUrgent ? cfg.ladderUrgentMin : cfg.ladderNormalMin;
    const step = Math.min(this.hub.state.alert.step, ladder.length - 1);
    return ladder[step] * 60_000;
  }

  /** Compute the next wake-up and the action due now (if any). Exposed for tests. */
  nextAction(now = this.clock.now()): { at: number; kind: 'first' | 'new' | 'reminder' | 'boot' | 'unsnooze' | 'retry' } | undefined {
    const s = this.hub.state;
    const cfg = s.config;
    const candidates: { at: number; kind: 'first' | 'new' | 'reminder' | 'boot' | 'unsnooze' | 'retry' }[] = [];
    for (const a of Object.values(s.attention)) {
      if (a.status === 'snoozed' && a.snoozeUntil) candidates.push({ at: Date.parse(a.snoozeUntil), kind: 'unsnooze' });
    }
    const open = this.openItems();
    if (open.length === 0) {
      this.windowStart = this.deadline = undefined;
      this.bootPendingUntil = undefined;
      return candidates.sort((x, y) => x.at - y.at)[0];
    }
    if (this.retryAt !== undefined) {
      // a failed alert is retried on its own backoff; nothing else may fire meanwhile
      candidates.push({ at: this.retryAt, kind: 'retry' });
    } else if (this.bootPendingUntil !== undefined) {
      candidates.push({ at: this.bootPendingUntil, kind: 'boot' });
    } else {
      const unalerted = open.filter((a) => !a.alertedAt);
      if (unalerted.length > 0) {
        if (this.windowStart === undefined) {
          this.windowStart = now;
          this.deadline = now + cfg.coalesceNormalMs;
        }
        if (unalerted.some((a) => a.urgency === 'urgent')) {
          const firstUrgent = Math.min(...unalerted.filter((a) => a.urgency === 'urgent').map((a) => Math.max(Date.parse(a.createdAt), this.windowStart!)));
          this.deadline = Math.min(this.deadline!, firstUrgent + cfg.coalesceUrgentMs, now + cfg.coalesceUrgentMs);
        }
        const anyAlerted = open.some((a) => a.alertedAt);
        candidates.push({ at: this.deadline!, kind: anyAlerted ? 'new' : 'first' });
      } else if (s.alert.anchor) {
        candidates.push({ at: Date.parse(s.alert.anchor) + this.ladderMs(), kind: 'reminder' });
      }
    }
    return candidates.sort((x, y) => x.at - y.at)[0];
  }

  schedule(): void {
    if (this.stopped) return;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.pushCounts();
    const next = this.nextAction();
    if (!next) return;
    const delay = Math.max(0, next.at - this.clock.now());
    this.timer = this.clock.setTimeout(() => void this.fire(), delay);
  }

  pushCounts(): void {
    const items = Object.values(this.hub.state.attention);
    const open = items.filter((a) => a.status === 'open');
    this.notify.setCounts({
      open: open.length,
      snoozed: items.filter((a) => a.status === 'snoozed').length,
      urgent: open.filter((a) => a.urgency === 'urgent').length,
    });
  }

  async fire(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const now = this.clock.now();
      // 1. snooze expiry
      const expired = Object.values(this.hub.state.attention).filter(
        (a) => a.status === 'snoozed' && a.snoozeUntil && Date.parse(a.snoozeUntil) <= now,
      );
      if (expired.length) {
        await this.hub.commit(expired.map((a) => draft('attention.unsnoozed', APP, { id: a.id })));
      }
      const next = this.nextAction(now);
      if (next && next.at <= now && next.kind !== 'unsnooze') {
        const kind = next.kind === 'retry' ? (this.openItems().some((a) => a.alertedAt) ? 'reminder' : 'first') : next.kind;
        await this.sendAlert(kind as 'first' | 'new' | 'reminder' | 'boot');
      }
    } finally {
      this.busy = false;
      this.schedule();
    }
  }

  private async sendAlert(kind: 'first' | 'new' | 'reminder' | 'boot'): Promise<void> {
    const open = this.openItems();
    if (open.length === 0) return;
    const now = this.clock.now();
    const sum = summarise(this.hub.state, kind, now);
    const alertId = ulid();
    const res = await this.notify.notify('attention', { id: alertId, ...sum });
    if (!res.ok) {
      await this.hub.commit(draft('alert.failed', APP, { error: res.error ?? 'unknown' }));
      this.retryAt = now + RETRY_MS[Math.min(this.retryIdx, RETRY_MS.length - 1)];
      this.retryIdx++;
      return;
    }
    this.retryAt = undefined;
    this.retryIdx = 0;
    this.windowStart = this.deadline = undefined;
    this.bootPendingUntil = undefined;
    const wasEmptyBefore = !this.hub.state.alert.anchor || open.every((a) => !a.alertedAt);
    const k = kind === 'new' && wasEmptyBefore ? 'first' : kind;
    await this.hub.commit(draft('attention.alerted', APP, { alertId, kind: k, itemIds: open.map((a) => a.id) }));
  }
}
