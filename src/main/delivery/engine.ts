import { APP, draft } from '../../shared/events';
import type { ChannelKind, PendingEvent } from '../../shared/types';
import type { StateHub } from '../store/state-hub';
import type { Clock } from '../attention/scheduler';
import { realClock } from '../attention/scheduler';

export interface ManagerTransport {
  /** session id of the live manager, if any */
  managerSession(): string | undefined;
  channelReady(session: string): boolean;
  pushChannel(session: string, content: string, meta: Record<string, string>): Promise<boolean>;
  /** true when a paste can be injected now (manager idle/ready and the user isn't typing) */
  canPaste(session: string): boolean;
  paste(session: string, text: string): Promise<void>;
  /** raise an app-origin attention item (manager never acknowledged an event) */
  raiseUnacked(ev: PendingEvent): Promise<void>;
}

const MAX_PUSHES = 3;
const MAX_BODY = 1500;

export function formatPaste(events: PendingEvent[]): string {
  return events
    .map((e) => {
      const meta = Object.entries(e.meta)
        .filter(([k]) => k !== 'id' && k !== 'kind')
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      const body = e.content.replace(/^\[(AGENTBOARD|END)/gm, '> [$1');
      return `[AGENTBOARD ${e.id} ${e.kind}${meta ? ' ' + meta : ''}]\n${body}\n[END ${e.id}]`;
    })
    .join('\n');
}

/**
 * App → manager event delivery (SPEC §6.8, §18.2): channel primary, paste fallback.
 * Events are persisted (`event.pushed`) before any transport attempt; delivery is retried
 * until the manager acknowledges, with redelivery measured from the manager's next Stop.
 */
export class DeliveryEngine {
  private undelivered: string[] = [];
  private lastStopAt = 0;
  private raised = new Set<string>();
  private flushing = false;

  constructor(
    private readonly hub: StateHub,
    private readonly t: ManagerTransport,
    private readonly clock: Clock = realClock,
  ) {}

  /** On boot: everything not acked is undelivered again. */
  boot(): void {
    this.undelivered = Object.values(this.hub.state.pending)
      .filter((p) => !p.acked)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((p) => p.id);
  }

  async enqueue(kind: ChannelKind, content: string, meta: Record<string, string> = {}): Promise<string> {
    const id = this.hub.nextId('E');
    let body = content;
    if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY) + '\n…(truncated; call the matching list_/get_ tool for full details)';
    await this.hub.commit(draft('event.pushed', APP, { id, kind, content: body, meta: { ...meta, id, kind }, via: this.t.channelReady(this.t.managerSession() ?? '') ? 'channel' : 'paste' }));
    this.undelivered.push(id);
    await this.flush();
    return id;
  }

  async ack(ids: string[]): Promise<void> {
    const drafts = ids.filter((id) => this.hub.state.pending[id] && !this.hub.state.pending[id].acked).map((id) => draft('event.acked', APP, { id }));
    if (drafts.length) await this.hub.commit(drafts);
    this.undelivered = this.undelivered.filter((x) => !ids.includes(x));
  }

  /** Ack every pending event whose meta references `key=value` (e.g. attention=A12). */
  async ackWhere(key: string, value: string): Promise<void> {
    const ids = Object.values(this.hub.state.pending)
      .filter((p) => !p.acked && p.meta[key] === value)
      .map((p) => p.id);
    if (ids.length) await this.ack(ids);
  }

  managerStopped(): void {
    this.lastStopAt = this.clock.now();
    void this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const session = this.t.managerSession();
      if (!session) return;
      this.undelivered = this.undelivered.filter((id) => this.hub.state.pending[id] && !this.hub.state.pending[id].acked);
      if (this.undelivered.length === 0) return;
      const events = this.undelivered.map((id) => this.hub.state.pending[id]);
      if (this.t.channelReady(session)) {
        const sent: string[] = [];
        for (const e of events) {
          const ok = await this.t.pushChannel(session, e.content, e.meta);
          if (!ok) break;
          sent.push(e.id);
        }
        this.undelivered = this.undelivered.filter((id) => !sent.includes(id));
      } else if (this.t.canPaste(session)) {
        const batch = events.slice(0, 10);
        await this.t.paste(session, formatPaste(batch));
        this.undelivered = this.undelivered.filter((id) => !batch.some((b) => b.id === id));
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Periodic: redeliver unacked events after the manager had a chance to act. */
  async tick(): Promise<void> {
    const now = this.clock.now();
    const waitMs = this.hub.state.config.ackRedeliverMin * 60_000;
    for (const p of Object.values(this.hub.state.pending)) {
      if (p.acked || this.undelivered.includes(p.id) || !p.pushedAt) continue;
      const pushedAt = Date.parse(p.pushedAt);
      if (now - pushedAt < waitMs || this.lastStopAt < pushedAt) continue;
      if (p.pushes >= MAX_PUSHES) {
        if (!this.raised.has(p.id)) {
          this.raised.add(p.id);
          await this.t.raiseUnacked(p);
        }
        continue;
      }
      await this.hub.commit(draft('event.redelivered', APP, { id: p.id, pushes: p.pushes + 1 }));
      this.undelivered.push(p.id);
    }
    await this.flush();
  }
}
