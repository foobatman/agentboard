import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code: 'GIT_FAILED' | 'CONFLICT' | 'DIRTY' | 'NOT_A_REPO' = 'GIT_FAILED',
    readonly files: string[] = [],
  ) {
    super(message);
  }
}

/** Scrubbed env for app-run git: keep auth agents, drop everything Claude/terminal related. */
function gitEnv(): NodeJS.ProcessEnv {
  const keep = ['HOME', 'PATH', 'USER', 'LANG', 'SSH_AUTH_SOCK', 'GIT_SSH_COMMAND', 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'GIT_CONFIG_GLOBAL'];
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0' };
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

export function git(cwd: string, args: string[], opts: { allowFail?: boolean; timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { env: gitEnv(), timeout: opts.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code as unknown as number) ?? 1 : 0;
      if (err && !opts.allowFail) reject(new GitError(`git ${args.join(' ')} failed: ${stderr.trim() || err.message}`, stderr));
      else resolve({ stdout: stdout.toString(), stderr: stderr.toString(), code: typeof code === 'number' ? code : 1 });
    });
  });
}

export async function repoRoot(p: string): Promise<string> {
  const r = await git(p, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (r.code !== 0) throw new GitError(`${p} is not a git repository`, r.stderr, 'NOT_A_REPO');
  return r.stdout.trim();
}

export async function defaultBranch(repo: string): Promise<string> {
  const r = await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true });
  if (r.code === 0 && r.stdout.trim()) return r.stdout.trim().replace(/^origin\//, '');
  const h = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return h.stdout.trim();
}

export async function addWorktree(repo: string, dir: string, branch: string, base: string): Promise<void> {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(repo, ['worktree', 'add', '-b', branch, dir, base]);
}

export async function isClean(dir: string): Promise<boolean> {
  const r = await git(dir, ['status', '--porcelain']);
  return r.stdout.trim() === '';
}

export async function commitsAhead(dir: string, base: string): Promise<number> {
  const r = await git(dir, ['rev-list', '--count', `${base}..HEAD`], { allowFail: true });
  return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
}

export async function diffStat(dir: string, base: string): Promise<string> {
  const r = await git(dir, ['diff', '--stat', `${base}...HEAD`], { allowFail: true });
  return r.stdout.trim();
}

export async function removeWorktree(repo: string, dir: string, force = false): Promise<void> {
  await git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), dir], { allowFail: !force });
  await git(repo, ['worktree', 'prune'], { allowFail: true });
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  await git(repo, ['branch', '-d', branch], { allowFail: true });
}

interface WorktreeInfo {
  path: string;
  branch?: string;
}

export async function listWorktrees(repo: string): Promise<WorktreeInfo[]> {
  const r = await git(repo, ['worktree', 'list', '--porcelain']);
  const out: WorktreeInfo[] = [];
  let cur: WorktreeInfo | undefined;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { path: line.slice(9) };
    } else if (line.startsWith('branch ') && cur) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Merge `branch` into `base` without touching the user's working copy (SPEC §18.6):
 * merge in a temporary detached worktree, then move the base ref (fast-forward the
 * checkout that has base, if any; refuse if that checkout is dirty).
 */
export async function mergeIntoBase(repo: string, base: string, branch: string, message?: string): Promise<{ commit: string; output: string }> {
  const oldBase = (await git(repo, ['rev-parse', `refs/heads/${base}`])).stdout.trim();
  const holder = (await listWorktrees(repo)).find((w) => w.branch === base);
  if (holder && !(await isClean(holder.path))) {
    throw new GitError(`${base} is checked out in ${holder.path} with uncommitted changes; refusing to merge`, '', 'DIRTY');
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-merge-'));
  fs.rmSync(tmp, { recursive: true, force: true });
  await git(repo, ['worktree', 'add', '--detach', tmp, oldBase]);
  try {
    const m = await git(tmp, ['-c', 'user.useConfigOnly=false', 'merge', '--no-ff', '--no-edit', '-m', message ?? `Merge ${branch} into ${base} (agentboard)`, branch], { allowFail: true });
    if (m.code !== 0) {
      const files = (await git(tmp, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true })).stdout.split('\n').filter(Boolean);
      await git(tmp, ['merge', '--abort'], { allowFail: true });
      throw new GitError(`merge conflict merging ${branch} into ${base}`, m.stderr + m.stdout, 'CONFLICT', files);
    }
    const commit = (await git(tmp, ['rev-parse', 'HEAD'])).stdout.trim();
    if (holder) {
      await git(holder.path, ['merge', '--ff-only', commit]);
    } else {
      await git(repo, ['update-ref', `refs/heads/${base}`, commit, oldBase]);
    }
    return { commit, output: m.stdout.trim() };
  } finally {
    await git(repo, ['worktree', 'remove', '--force', tmp], { allowFail: true });
    await git(repo, ['worktree', 'prune'], { allowFail: true });
  }
}

export async function pushBranch(repo: string, branch: string, remote = 'origin'): Promise<string> {
  const r = await git(repo, ['push', remote, `refs/heads/${branch}:refs/heads/${branch}`], { timeoutMs: 300_000 });
  return (r.stdout + r.stderr).trim();
}
