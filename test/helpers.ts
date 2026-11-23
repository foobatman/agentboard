import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventStore } from '../src/main/store/event-store';
import { StateHub } from '../src/main/store/state-hub';
import type { Clock } from '../src/main/attention/scheduler';
import { afterEach } from 'vitest';

// Close every hub's event-log FileHandle after each test (Node >= 25 errors on GC-closed handles).
const openHubs: StateHub[] = [];
afterEach(async () => {
  await Promise.all(openHubs.splice(0).map((h) => h.store.close().catch(() => undefined)));
});

export function tmpDir(prefix = 'ab-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function newHub(dir = tmpDir(), clock?: { now(): number }): Promise<StateHub> {
  const hub = new StateHub(new EventStore(path.join(dir, 'events.jsonl'), clock ? () => clock.now() : Date.now));
  await hub.boot();
  openHubs.push(hub);
  return hub;
}

/** Deterministic clock with manual advance. */
export class FakeClock implements Clock {
  t = Date.parse('2026-11-19T10:00:00Z');
  timers: { at: number; fn: () => void; id: number }[] = [];
  private n = 0;
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.n;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== h);
  }
  /** Advance time, firing due timers in order (awaiting async work between them). */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      next.fn();
      await flush();
    }
    this.t = end;
    await flush();
  }
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 3));
}
