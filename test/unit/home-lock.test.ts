import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { acquireHomeLock } from '../../src/main/app/home-lock';
import { tmpDir } from '../helpers';

describe('home lock', () => {
  it('blocks a second holder while the first process is alive', () => {
    const home = tmpDir();
    // a live foreign pid: our parent process
    fs.writeFileSync(path.join(home, 'agentboard.lock'), String(process.ppid));
    expect(acquireHomeLock(home)).toEqual({ ok: false, pid: process.ppid });
  });
  it('takes over a stale lock and releases it', () => {
    const home = tmpDir();
    const dead = spawnSync('true').pid!;
    fs.writeFileSync(path.join(home, 'agentboard.lock'), String(dead));
    const l = acquireHomeLock(home);
    expect(l.ok).toBe(true);
    expect(fs.readFileSync(path.join(home, 'agentboard.lock'), 'utf8')).toBe(String(process.pid));
    if (l.ok) l.release();
    expect(fs.existsSync(path.join(home, 'agentboard.lock'))).toBe(false);
  });
});
