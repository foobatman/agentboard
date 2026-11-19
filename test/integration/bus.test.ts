import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { Bus, type BusHandlers, type Identity } from '../../src/main/bus/server';
import { ToolError } from '../../src/main/bus/tools';

function handlers(log: unknown[]): BusHandlers {
  return {
    async callTool(id, name, args) {
      log.push({ id: id.name, name, args });
      if (name === 'get_task') throw new ToolError('NOT_FOUND', 'no such task');
      return { ok: true, name };
    },
    async onHook(id, event, body) {
      log.push({ hook: event, body });
      return event === 'pre-tool-use' ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } } : undefined;
    },
    onStatusline(id, body) { log.push({ statusline: body }); },
    onLeak() {},
    onChannelReady(id, ready) { log.push({ channel: ready }); },
    fallbackB: () => false,
  };
}

async function connect(bus: Bus, token: string, channel = false) {
  const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${bus.url}/mcp${channel ? '?channel=1' : ''}`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

let bus: Bus | undefined;
afterEach(async () => { await bus?.stop(); bus = undefined; });

describe('Bus', () => {
  it('serves role-filtered MCP tools and maps errors', async () => {
    const log: unknown[] = [];
    bus = new Bus(handlers(log));
    await bus.start();
    const mgr: Identity = { role: 'manager', session: 's-m', name: 'manager' };
    const wrk: Identity = { role: 'worker', session: 's-w', name: 'login-tests', worker: 'W1', task: 'T1' };
    const tm = bus.tokens.issue(mgr);
    const tw = bus.tokens.issue(wrk);
    const cm = await connect(bus, tm);
    const cw = await connect(bus, tw);
    const mt = (await cm.listTools()).tools.map((t) => t.name);
    const wt = (await cw.listTools()).tools.map((t) => t.name);
    expect(mt).toContain('spawn_worker');
    expect(mt).not.toContain('done');
    expect(wt.sort()).toEqual(['done', 'report_progress', 'request_approval']);
    const r = await cw.callTool({ name: 'report_progress', arguments: { summary: 'half way' } });
    expect(JSON.parse((r.content as { text: string }[])[0].text)).toEqual({ ok: true, name: 'report_progress' });
    const e = await cm.callTool({ name: 'get_task', arguments: { task_id: 'T9' } });
    expect(e.isError).toBe(true);
    expect((e.content as { text: string }[])[0].text).toMatch(/NOT_FOUND/);
    // a worker cannot call manager tools
    const bad = await cw.callTool({ name: 'spawn_worker', arguments: {} }).catch((x) => x);
    expect(String(JSON.stringify(bad))).toMatch(/not found|Tool spawn_worker|-32602|error/i);
    await cm.close(); await cw.close();
  });

  it('rejects bad tokens, foreign Host and Origin headers', async () => {
    bus = new Bus(handlers([]));
    await bus.start();
    const r1 = await fetch(`${bus.url}/hooks/stop`, { method: 'POST', body: '{}' });
    expect(r1.status).toBe(401);
    const tok = bus.tokens.issue({ role: 'worker', session: 's', name: 'x-worker' });
    const r2 = await fetch(`${bus.url}/hooks/stop`, { method: 'POST', body: '{}', headers: { Authorization: `Bearer ${tok}`, Origin: 'http://evil' } });
    expect(r2.status).toBe(403);
    const r3 = await fetch(`${bus.url}/hooks/pre-tool-use`, { method: 'POST', body: '{"tool_name":"Bash"}', headers: { Authorization: `Bearer ${tok}` } });
    expect(await r3.json()).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    bus.tokens.revoke('s');
    const r4 = await fetch(`${bus.url}/statusline`, { method: 'POST', body: '{}', headers: { Authorization: `Bearer ${tok}` } });
    expect(r4.status).toBe(401);
  });

  it('pushes channel notifications to the manager MCP session', async () => {
    const log: unknown[] = [];
    bus = new Bus(handlers(log));
    await bus.start();
    const mgr: Identity = { role: 'manager', session: 's-m', name: 'manager' };
    const tok = bus.tokens.issue(mgr);
    const client = await connect(bus, tok, true);
    expect(client.getServerCapabilities()?.experimental).toHaveProperty(['claude/channel']);
    const got: unknown[] = [];
    client.setNotificationHandler(
      z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }) }),
      (n) => { got.push(n.params); },
    );
    // give the client a moment to open its standalone SSE stream
    await new Promise((r) => setTimeout(r, 300));
    expect(await bus.pushChannel('s-m', 'hello', { kind: 'system', id: 'E1' })).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(got).toEqual([{ content: 'hello', meta: { kind: 'system', id: 'E1' } }]);
    expect(log).toContainEqual({ channel: true });
    await client.close();
  });
});
