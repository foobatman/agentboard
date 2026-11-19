#!/usr/bin/env node
// A stand-in for the `claude` CLI used by agentboard's integration tests.
// It honours the flags agentboard passes, runs the configured hooks through the real
// ab-hook relay, connects to the bus MCP endpoint (channel mode for the manager), and
// simulates turns when a prompt is submitted. Never talks to Anthropic.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flagsWithValue = new Set(['--session-id', '--resume', '--name', '--model', '--permission-mode', '--settings', '--setting-sources', '--mcp-config', '--append-system-prompt-file', '--add-dir', '--dangerously-load-development-channels']);
let positional;
for (let i = 0; i < argv.length; i++) {
  if (flagsWithValue.has(argv[i])) i++;
  else if (!argv[i].startsWith('--')) positional = argv[i];
}
const sessionId = opt('--session-id') ?? opt('--resume');
const name = opt('--name') ?? 'fake';
const settings = JSON.parse(fs.readFileSync(opt('--settings'), 'utf8'));
const mcp = JSON.parse(fs.readFileSync(opt('--mcp-config'), 'utf8'));
const channel = argv.includes('--dangerously-load-development-channels');
const logDir = path.join(process.env.TMPDIR ?? '/tmp', 'fake-claude');
fs.mkdirSync(logDir, { recursive: true });
const log = (obj) => fs.appendFileSync(path.join(logDir, `${name}.jsonl`), JSON.stringify({ t: Date.now(), ...obj }) + '\n');
log({ kind: 'start', argv, cwd: process.cwd(), env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(AGENTBOARD_|TERM|CLAUDE|NO_PROXY|PATH)/.test(k))) });

function hook(event, payload = {}) {
  const h = settings.hooks?.[event]?.[0]?.hooks?.[0];
  if (!h) return Promise.resolve('');
  return new Promise((resolve) => {
    const child = execFile('/bin/sh', ['-c', h.command], { env: process.env, timeout: 60_000 }, (err, stdout) => resolve(stdout.toString().trim()));
    child.stdin.end(JSON.stringify({ session_id: sessionId, hook_event_name: event, cwd: process.cwd(), ...payload }));
  });
}

const out = (s) => process.stdout.write(s);
const prompt = () => out('\r\n──────────\r\n❯ \r\n──────────\r\n');

let client;
async function connectMcp() {
  const cfg = mcp.mcpServers.agentboard;
  const headers = Object.fromEntries(Object.entries(cfg.headers ?? {}).map(([k, v]) => [k, String(v).replace(/\$\{(\w+)\}/g, (_, n) => process.env[n] ?? '')]));
  client = new Client({ name: 'fake-claude', version: '0' }, { capabilities: {} });
  client.setNotificationHandler(z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }) }), (n) => {
    log({ kind: 'channel', ...n.params });
    out(`\r\n<channel source="agentboard" kind="${n.params.meta.kind}" id="${n.params.meta.id}">${n.params.content}</channel>\r\n`);
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers } }));
  log({ kind: 'mcp', tools: (await client.listTools()).tools.map((t) => t.name), channelCap: !!client.getServerCapabilities()?.experimental?.['claude/channel'] });
}

async function turn(text) {
  log({ kind: 'prompt', text });
  await hook('UserPromptSubmit', { prompt: text });
  out(`\r\n● ${text.slice(0, 200).replace(/\n/g, ' ')}\r\n`);
  if (text.startsWith('!bell')) out('\x07\x1b]9;leak\x07\x1b]777;notify;x;y\x1b\\\x1b]99;i=1:p=body\x07');
  const m = /^!tool (\S+) (.*)$/s.exec(text);
  if (m) {
    const res = await hook('PreToolUse', { tool_name: m[1], tool_input: JSON.parse(m[2]) });
    log({ kind: 'pretool', tool: m[1], res });
    out(`\r\n[pretool ${m[1]}] ${res}\r\n`);
  }
  await hook('Stop', {});
  prompt();
}

if (process.env.FAKE_TRUST === '1') {
  out('Quick safety check\r\n❯ No, exit\r\n  Yes, I trust this folder\r\nEnter to confirm · Esc to cancel\r\n');
  await new Promise((resolve) => {
    let sawDown = false;
    process.stdin.setRawMode?.(true);
    const onData = (d) => {
      const s = d.toString();
      if (s.includes('\x1b[B')) sawDown = true;
      if (s.includes('\r')) {
        if (!sawDown) {
          out("Claude Code didn't start because this folder isn't trusted.\r\n");
          process.exit(1);
        }
        process.stdin.off('data', onData);
        out('\x1b[2J\x1b[H');
        resolve();
      }
    };
    process.stdin.on('data', onData);
  });
}

await hook('SessionStart', { source: opt('--resume') ? 'resume' : 'startup' });
try {
  await connectMcp();
} catch (e) {
  log({ kind: 'mcp_error', error: String(e) });
}
out(`fake claude ${name} ready\r\n`);
prompt();
if (positional) await turn(positional);

process.stdin.setRawMode?.(true);
let buf = '';
let ctrlC = 0;
process.stdin.on('data', async (d) => {
  const s = d.toString();
  if (s === '\x03') {
    if (++ctrlC >= 2) {
      log({ kind: 'exit' });
      await hook('SessionEnd', {});
      process.exit(0);
    }
    return;
  }
  ctrlC = 0;
  if (s === '\x1b') return;
  buf += s;
  if (buf.includes('\r')) {
    const text = buf.split('\r')[0].replace(/\x1b\[20[01]~/g, '').trim();
    buf = '';
    if (text) await turn(text);
  }
});
process.on('SIGTERM', () => process.exit(0));
