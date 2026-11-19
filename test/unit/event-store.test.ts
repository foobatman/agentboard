import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventStore, LogIntegrityError } from '../../src/main/store/event-store';
import { StateHub } from '../../src/main/store/state-hub';
import { APP, USER, draft } from '../../src/shared/events';
import { tmpDir } from '../helpers';

const taskDraft = (id: string) =>
  draft('task.created', USER, {
    id, title: 'Write tests', description: 'd', kind: 'code', priority: 3,
    escalation: { preset: 'default' }, preAuthorized: [], skillsHint: [], dependsOn: [], mcpServers: [], source: 'board',
  });

describe('EventStore', () => {
  it('appends with gap-free seq and replays state', async () => {
    const dir = tmpDir();
    const hub = new StateHub(new EventStore(path.join(dir, 'events.jsonl')));
    await hub.boot();
    await hub.commit([taskDraft('T1'), taskDraft('T2')]);
    await hub.commit(draft('task.status_changed', APP, { id: 'T1', from: 'inbox', to: 'planned', reason: 'x' }));
    await hub.store.close();
    const hub2 = new StateHub(new EventStore(path.join(dir, 'events.jsonl')));
    const r = await hub2.boot();
    expect(r.replayed).toBe(3);
    expect(hub2.state.tasks.T1.status).toBe('planned');
    expect(hub2.state.counters.T).toBe(2);
    expect(hub2.nextId('T')).toBe('T3');
  });

  it('concurrent commits are group-committed in order', async () => {
    const dir = tmpDir();
    const hub = new StateHub(new EventStore(path.join(dir, 'events.jsonl')));
    await hub.boot();
    await Promise.all(Array.from({ length: 50 }, (_, i) => hub.commit(taskDraft(`T${i + 1}`))));
    const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('quarantines and truncates a torn final line', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'events.jsonl');
    const hub = new StateHub(new EventStore(file));
    await hub.boot();
    await hub.commit([taskDraft('T1')]);
    await hub.store.close();
    fs.appendFileSync(file, '{"v":1,"seq":2,"id":"x","ts":"2026');
    const store = new EventStore(file);
    const r = store.load();
    expect(r.events).toHaveLength(1);
    expect(r.tornBytes).toBeGreaterThan(0);
    expect(fs.existsSync(r.quarantineFile!)).toBe(true);
    expect(fs.readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
  });

  it('refuses a corrupt middle line', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'events.jsonl');
    fs.writeFileSync(file, 'garbage\n{"v":1,"seq":1}\n');
    expect(() => new EventStore(file).load()).toThrow(LogIntegrityError);
  });
});
