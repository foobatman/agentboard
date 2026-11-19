import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { addWorktree, commitsAhead, defaultBranch, isClean, mergeIntoBase, GitError } from '../../src/main/work/git';
import { tmpDir } from '../helpers';

function sh(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }).toString();
}
function mkRepo() {
  const d = tmpDir('ab-repo-');
  sh(d, 'init', '-q', '-b', 'main');
  sh(d, 'config', 'user.email', 't@x'); sh(d, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'a.txt'), 'one\n');
  sh(d, 'add', '.'); sh(d, 'commit', '-qm', 'init');
  return d;
}

describe('git service', () => {
  it('creates a worktree, merges without touching a dirty-free main checkout', async () => {
    const repo = mkRepo();
    expect(await defaultBranch(repo)).toBe('main');
    const wt = path.join(tmpDir('ab-wt-'), 'T1-x');
    await addWorktree(repo, wt, 'agentboard/T1-x', 'main');
    fs.writeFileSync(path.join(wt, 'b.txt'), 'two\n');
    sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'feature');
    expect(await isClean(wt)).toBe(true);
    expect(await commitsAhead(wt, 'main')).toBe(1);
    const r = await mergeIntoBase(repo, 'main', 'agentboard/T1-x');
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(fs.existsSync(path.join(repo, 'b.txt'))).toBe(true); // main checkout fast-forwarded
    expect(sh(repo, 'log', '--oneline').split('\n').filter(Boolean)).toHaveLength(3);
  });

  it('reports conflicts and leaves base unchanged', async () => {
    const repo = mkRepo();
    const wt = path.join(tmpDir('ab-wt-'), 'T2-x');
    await addWorktree(repo, wt, 'agentboard/T2-x', 'main');
    fs.writeFileSync(path.join(wt, 'a.txt'), 'theirs\n');
    sh(wt, 'commit', '-qam', 'theirs');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'ours\n');
    sh(repo, 'commit', '-qam', 'ours');
    const before = sh(repo, 'rev-parse', 'main');
    const e = await mergeIntoBase(repo, 'main', 'agentboard/T2-x').catch((x) => x);
    expect(e).toBeInstanceOf(GitError);
    expect(e.code).toBe('CONFLICT');
    expect(e.files).toEqual(['a.txt']);
    expect(sh(repo, 'rev-parse', 'main')).toBe(before);
  });

  it('refuses when base is checked out dirty', async () => {
    const repo = mkRepo();
    const wt = path.join(tmpDir('ab-wt-'), 'T3-x');
    await addWorktree(repo, wt, 'agentboard/T3-x', 'main');
    fs.writeFileSync(path.join(wt, 'c.txt'), 'c\n'); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'c');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'dirty\n');
    const e = await mergeIntoBase(repo, 'main', 'agentboard/T3-x').catch((x) => x);
    expect(e.code).toBe('DIRTY');
  });
});
