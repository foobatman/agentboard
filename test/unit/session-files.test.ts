import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeArgs, writeChannelDeclaration } from '../../src/main/pty/session-files';
import { tmpDir } from '../helpers';

const files = { settings: 's.json', mcp: 'm.json', systemAppend: 'a.md' };

describe('claudeArgs', () => {
  it('ends variadic flags with -- before the start prompt', () => {
    const a = claudeArgs({ sessionId: 'x', resume: false, name: 'manager', permissionMode: 'default', files, addDirs: ['/d'], channel: true, startPrompt: 'hello' });
    expect(a.slice(-4)).toEqual(['--dangerously-load-development-channels', 'server:agentboard', '--', 'hello']);
  });
});

describe('writeChannelDeclaration', () => {
  it('declares only the agentboard channel server, without the token, and removes it when disabled', () => {
    const cwd = tmpDir();
    writeChannelDeclaration(cwd, 'http://127.0.0.1:4321');
    const file = path.join(cwd, '.mcp.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(Object.keys(cfg.mcpServers)).toEqual(['agentboard']);
    expect(cfg.mcpServers.agentboard.url).toBe('http://127.0.0.1:4321/mcp?channel=1');
    expect(cfg.mcpServers.agentboard.headers.Authorization).toBe('Bearer ${AGENTBOARD_TOKEN}');
    writeChannelDeclaration(cwd, null);
    expect(fs.existsSync(file)).toBe(false);
  });
});
