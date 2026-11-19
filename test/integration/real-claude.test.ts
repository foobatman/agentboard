// Opt-in check against the real Claude Code CLI. Sends NO prompt (no model call, no plan usage).
// Run: AB_REAL_CLAUDE=1 AB_CLAUDE_CONFIG_DIR=<isolated config with onboarding done> npx vitest run test/integration/real-claude.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import * as pty from 'node-pty';
import { Orchestrator } from '../../src/main/app/orchestrator';
import { PtyManager } from '../../src/main/pty/pty-manager';
import { EventStore } from '../../src/main/store/event-store';
import { StateHub } from '../../src/main/store/state-hub';
import { tmpDir } from '../helpers';

const RUN = process.env.AB_REAL_CLAUDE === '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!RUN)('real claude CLI (no model calls)', () => {
  let orch: Orchestrator | undefined;
  afterAll(async () => orch?.shutdown());
  it('manager session: dialogs auto-answered, SessionStart hook, channel over HTTP MCP, statusLine feed', async () => {
    const home = process.env.AB_HOME_DIR ?? tmpDir('ab-real-');
    fs.mkdirSync(home, { recursive: true });
    const hub = new StateHub(new EventStore(path.join(home, 'events.jsonl')));
    await hub.boot();
    const ptys = new PtyManager((f, a, o) => pty.spawn(f, a, o));
    orch = new Orchestrator({
      hub, ptys, home, resources: path.resolve(__dirname, '../../resources'), claudePath: process.env.AB_CLAUDE ?? 'claude',
      loginPath: process.env.PATH!, baseEnv: process.env, configDir: process.env.AB_CLAUDE_CONFIG_DIR,
    });
    await orch.start();
    const dialogs: string[] = [];
    ptys.on('spawned', (p) => p.on('dialog', (d: { id: string }) => dialogs.push(d.id)));
    const sess = { id: crypto.randomUUID(), role: 'manager' as const, name: 'manager', cwd: path.join(home, 'manager'), state: 'spawning' as const, stateSince: '', crashCount: 0, cleanedUp: false, resumeCount: 0 };
    await (orch as unknown as { spawnSession: (s: unknown, r: boolean, e: unknown) => Promise<unknown> }).spawnSession(sess, false, { startPrompt: '' });
    const end = Date.now() + 60_000;
    while (Date.now() < end && !(orch.bus.hasChannel(sess.id) && orch.usage.live[sess.id])) await sleep(500);
    const st = hub.state.sessions[sess.id];
    const p = ptys.get(sess.id);
    console.log('dialogs', dialogs, 'state', st.state, 'channel', orch.bus.hasChannel(sess.id), 'usage', JSON.stringify(orch.usage.live[sess.id]));
    console.log(p?.tail(25));
    expect(['ready', 'idle']).toContain(st.state);
    expect(orch.bus.hasChannel(sess.id)).toBe(true);
    expect(orch.usage.live[sess.id]?.model).toBeTruthy();
    // channel push lands in the real session
    const ok = await orch.bus.pushChannel(sess.id, 'agentboard spike: please ignore', { kind: 'system', id: 'E0' });
    expect(ok).toBe(true);
  }, 120_000);
});
