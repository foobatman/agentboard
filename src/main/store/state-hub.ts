import { EventEmitter } from 'node:events';
import type { DraftEvent, EventEnvelope } from '../../shared/events';
import { emptyState, type State } from '../../shared/types';
import { EventStore } from './event-store';
import { reduce, replay } from './reducer';

/**
 * Owns the authoritative in-memory state. All mutations go through `commit()`, which
 * persists first (fsync) and only then reduces and notifies listeners.
 */
export class StateHub extends EventEmitter {
  state: State = emptyState();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly store: EventStore) {
    super();
  }

  /** Load + replay. Returns repair info. */
  async boot(): Promise<{ tornBytes: number; quarantineFile?: string; replayed: number }> {
    const res = this.store.load();
    this.state = replay(res.events, emptyState());
    await this.store.open();
    return { tornBytes: res.tornBytes, quarantineFile: res.quarantineFile, replayed: res.events.length };
  }

  /**
   * Persist events, then apply them. Serialised so reducers see events in seq order.
   * Side effects must be performed by the caller only after this resolves.
   */
  commit(drafts: DraftEvent | DraftEvent[]): Promise<EventEnvelope[]> {
    const list = Array.isArray(drafts) ? drafts : [drafts];
    const p = this.chain.then(async () => {
      const envs = await this.store.append(list);
      for (const e of envs) reduce(this.state, e);
      if (envs.length) this.emit('events', envs);
      return envs;
    });
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** Next id for a counter prefix (T, W, A, R, P, G, E, RP), reserving it in memory. */
  nextId(prefix: keyof State['counters']): string {
    const n = this.state.counters[prefix] + 1;
    this.state.counters[prefix] = n;
    return `${prefix}${n}`;
  }
}
