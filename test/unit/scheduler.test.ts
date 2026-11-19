import { describe, expect, it } from 'vitest';
import { AttentionScheduler } from '../../src/main/attention/scheduler';
import { NotificationService, RecordingNotifier } from '../../src/main/notify/notification-service';
import { APP, USER, draft } from '../../src/shared/events';
import type { AttentionItem } from '../../src/shared/types';
import { FakeClock, newHub } from '../helpers';

function mk(id: string, clock: FakeClock, urgency: 'normal' | 'urgent' = 'normal'): AttentionItem {
  return {
    id, kind: 'decision', origin: 'manager', question: `question ${id}?`, options: [{ key: 'a', label: 'Yes' }],
    irreversible: false, urgency, blocks: { summary: '', workers: [], tasks: [] }, status: 'open',
    createdAt: new Date(clock.now()).toISOString(), snoozeCount: 0, deliveredCount: 0, alertCount: 0,
  };
}

async function setup(boot = false) {
  const clock = new FakeClock();
  const hub = await newHub(undefined, clock);
  const rec = new RecordingNotifier();
  const sched = new AttentionScheduler(hub, new NotificationService(rec), clock);
  return { clock, hub, rec, sched, start: () => sched.start(boot) };
}

describe('AttentionScheduler', () => {
  it('coalesces items arriving inside the 60s window into one alert', async () => {
    const { clock, hub, rec, start } = await setup();
    start();
    await hub.commit(draft('attention.created', APP, mk('A1', clock)));
    await clock.advance(20_000);
    await hub.commit(draft('attention.created', APP, mk('A2', clock)));
    await clock.advance(20_000);
    expect(rec.shown).toHaveLength(0);
    await clock.advance(21_000);
    expect(rec.shown).toHaveLength(1);
    expect(rec.shown[0].body).toMatch(/^2 items need you/);
    expect(rec.counts.open).toBe(2);
  });

  it('urgent items shorten the window to 10s', async () => {
    const { clock, hub, rec, start } = await setup();
    start();
    await hub.commit(draft('attention.created', APP, mk('A1', clock)));
    await clock.advance(5_000);
    await hub.commit(draft('attention.created', APP, mk('A2', clock, 'urgent')));
    await clock.advance(10_500);
    expect(rec.shown).toHaveLength(1);
    expect(rec.shown[0].body).toMatch(/1 urgent/);
  });

  it('reminds on the ladder until answered, then stops', async () => {
    const { clock, hub, rec, start } = await setup();
    start();
    await hub.commit(draft('attention.created', APP, mk('A1', clock)));
    await clock.advance(61_000);
    expect(rec.shown).toHaveLength(1);
    await clock.advance(15 * 60_000);
    expect(rec.shown).toHaveLength(2);
    await clock.advance(30 * 60_000);
    expect(rec.shown).toHaveLength(3);
    await clock.advance(60 * 60_000);
    expect(rec.shown).toHaveLength(4);
    await hub.commit(draft('attention.answered', USER, { id: 'A1', answer: { optionKey: 'a', via: 'ui', at: new Date(clock.now()).toISOString() } }));
    await clock.advance(5 * 3600_000);
    expect(rec.shown).toHaveLength(4);
    expect(rec.counts.open).toBe(0);
  });

  it('snooze hides an item and re-alerts it when the snooze expires', async () => {
    const { clock, hub, rec, start } = await setup();
    start();
    await hub.commit(draft('attention.created', APP, mk('A1', clock)));
    await clock.advance(61_000);
    await hub.commit(draft('attention.snoozed', USER, { id: 'A1', until: new Date(clock.now() + 30 * 60_000).toISOString() }));
    await clock.advance(29 * 60_000);
    expect(rec.shown).toHaveLength(1); // no reminders while snoozed
    await clock.advance(2 * 60_000);
    expect(hub.state.attention.A1.status).toBe('open');
    await clock.advance(16 * 60_000);
    expect(rec.shown.length).toBeGreaterThanOrEqual(2);
  });

  it('re-alerts open items right after boot', async () => {
    const { clock, hub, rec, sched } = await setup();
    await hub.commit(draft('attention.created', APP, mk('A1', clock)));
    sched.start(true);
    await clock.advance(3_500);
    expect(rec.shown).toHaveLength(1);
    expect(rec.shown[0].body).toMatch(/^Still open/);
  });

  it('retries a failed OS alert and logs alert.failed', async () => {
    const { clock, hub, rec, start } = await setup();
    rec.fail = true;
    start();
    await hub.commit(draft('attention.created', APP, mk('A1', clock)));
    await clock.advance(61_000);
    expect(rec.shown).toHaveLength(0);
    rec.fail = false;
    await clock.advance(31_000);
    expect(rec.shown).toHaveLength(1);
  });
});
