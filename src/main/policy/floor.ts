import os from 'node:os';
import path from 'node:path';
import { parse as shellParse } from 'shell-quote';
import type { Grant } from '../../shared/types';

/**
 * Permission floor evaluated in the PreToolUse hook (SPEC §18.4). It runs before Claude
 * Code's allow rules, so allow-prefixes cannot bypass it. Returns:
 *  - deny: block the call, with a reason shown to the model
 *  - allow: an irreversible action covered by a grant
 *  - none: not our concern; Claude Code's normal permission flow applies
 */
export type FloorDecision =
  | { decision: 'deny'; reason: string; category: 'irreversible' | 'notify' | 'topology' | 'nested' }
  | { decision: 'allow'; reason: string; grantId: string }
  | { decision: 'none'; note?: string };

export interface FloorContext {
  role: 'manager' | 'worker';
  cwd: string;
  /** directories the session may delete inside (worktree/workspace, task dir) */
  writableRoots: string[];
  grants: Grant[];
  managerName?: string;
}

const NOTIFIER_CMDS = new Set(['osascript', 'terminal-notifier', 'say', 'afplay', 'alerter', 'growlnotify', 'notify-send']);

const IRREVERSIBLE_SUBCOMMANDS: [string, RegExp][] = [
  ['git', /^(push|merge|send-email|request-pull)$/],
  ['gh', /^(pr|release|repo|api|issue|gist|secret|workflow|run)$/],
  ['npm', /^(publish|unpublish|deprecate|owner|dist-tag)$/],
  ['pnpm', /^(publish)$/],
  ['yarn', /^(publish|npm)$/],
  ['cargo', /^(publish|yank)$/],
  ['twine', /^(upload)$/],
  ['docker', /^(push|login)$/],
  ['kubectl', /^(apply|delete|create|replace|patch|scale|rollout|drain|cordon)$/],
  ['helm', /^(install|upgrade|uninstall|delete|rollback)$/],
  ['terraform', /^(apply|destroy|import)$/],
  ['pulumi', /^(up|destroy)$/],
  ['fly', /^(deploy|destroy|apps)$/],
  ['flyctl', /^(deploy|destroy)$/],
  ['vercel', /^(deploy|--prod|remove|rm)$/],
  ['netlify', /^(deploy)$/],
  ['firebase', /^(deploy)$/],
  ['heroku', /.*/],
  ['aws', /.*/],
  ['gcloud', /.*/],
  ['az', /.*/],
  ['stripe', /.*/],
];

const ALWAYS_IRREVERSIBLE = new Set(['sudo', 'doas', 'su', 'shutdown', 'reboot', 'mkfs', 'diskutil', 'dd', 'launchctl', 'crontab', 'sendmail', 'mail', 'mutt', 'scp', 'rsync', 'ssh']);

const MCP_IRREVERSIBLE = /(send|delete|trash|remove|publish|deploy|pay|transfer|post|purchase|forward|reply|archive|unsubscribe|share|invite|create_?event|cancel)/i;

type Token = string | { op?: string; pattern?: string; comment?: string };

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function within(p: string, roots: string[]): boolean {
  const r = path.resolve(p);
  return roots.some((root) => {
    const rr = path.resolve(root);
    return r === rr || r.startsWith(rr + path.sep);
  });
}

/** Split a shell command into simple commands (argv arrays). Unresolvable parts are marked. */
export function splitCommands(cmd: string): { argv: string[]; unresolved: boolean }[] {
  let tokens: Token[];
  try {
    tokens = shellParse(cmd, (key: string) => `\u0000$${key}`) as Token[];
  } catch {
    return [{ argv: [cmd], unresolved: true }];
  }
  const out: { argv: string[]; unresolved: boolean }[] = [];
  let cur: string[] = [];
  let unresolved = false;
  const flushCur = () => {
    if (cur.length) out.push({ argv: cur, unresolved });
    cur = [];
    unresolved = false;
  };
  for (const t of tokens) {
    if (typeof t === 'string') {
      if (t.includes('\u0000$')) unresolved = true;
      cur.push(t.replace(/\u0000/g, ''));
    } else if (t.op === 'glob' || t.pattern !== undefined) {
      cur.push(String(t.pattern));
      unresolved = true;
    } else if (t.op === '(' || t.op === ')' || t.op === '<(') {
      unresolved = true;
    } else if (t.op && ['>', '>>', '<', '>&', '<&', '|&'].includes(t.op)) {
      cur.push(t.op);
    } else if (t.op) {
      flushCur();
    }
  }
  flushCur();
  return out;
}

function stripPrefixes(argv: string[]): string[] {
  let i = 0;
  // env assignments and wrappers that don't change semantics
  while (i < argv.length) {
    const a = argv[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) i++;
    else if (['env', 'command', 'builtin', 'nohup', 'time', 'nice', 'exec', 'xargs'].includes(path.basename(a))) i++;
    else break;
  }
  return argv.slice(i);
}

function classifySimple(argvIn: string[], unresolved: boolean, ctx: FloorContext, depth: number): { kind: 'irreversible' | 'notify' | 'nested' | 'ok'; why: string } {
  const argv = stripPrefixes(argvIn);
  if (argv.length === 0) return { kind: 'ok', why: '' };
  const prog = path.basename(argv[0]);
  if (NOTIFIER_CMDS.has(prog)) return { kind: 'notify', why: `${prog} can raise user-visible notifications` };
  if (prog === 'open' && ctx.role === 'worker') return { kind: 'notify', why: 'open can bring apps to the foreground' };
  if (prog === 'claude' && ctx.role === 'worker') return { kind: 'nested', why: 'workers may not start other Claude sessions' };
  if (ALWAYS_IRREVERSIBLE.has(prog)) return { kind: 'irreversible', why: `${prog} is irreversible or privileged` };
  if ((prog === 'bash' || prog === 'sh' || prog === 'zsh' || prog === 'fish') && argv.includes('-c')) {
    const inner = argv[argv.indexOf('-c') + 1];
    if (inner === undefined || depth > 3) return { kind: 'irreversible', why: 'unresolvable nested shell' };
    const r = classifyCommand(inner, ctx, depth + 1);
    return r;
  }
  if (prog === 'eval') return { kind: 'irreversible', why: 'eval cannot be analysed' };
  for (const [p, re] of IRREVERSIBLE_SUBCOMMANDS) {
    if (prog === p) {
      const sub = argv.slice(1).find((a) => !a.startsWith('-')) ?? '';
      if (p === 'gh') {
        // gh read-only commands are fine; mutations are not
        const rest = argv.slice(1).join(' ');
        if (/\b(merge|create|delete|close|edit|comment|review|upload|set|run|dispatch|enable|disable|rename|archive|transfer|fork|-X\s*(POST|PUT|PATCH|DELETE)|--method\s*(POST|PUT|PATCH|DELETE))\b/i.test(rest))
          return { kind: 'irreversible', why: `gh ${sub} mutates remote state` };
        return { kind: 'ok', why: '' };
      }
      if (re.test(sub)) return { kind: 'irreversible', why: `${p} ${sub} is irreversible` };
    }
  }
  if (prog === 'git') {
    const rest = argv.slice(1);
    if (rest.includes('--force') || rest.includes('--force-with-lease') || (rest[0] === 'push' && rest.includes('-f'))) return { kind: 'irreversible', why: 'forced git operation' };
    if (rest[0] === 'branch' && (rest.includes('-D') || rest.includes('--delete'))) return { kind: 'irreversible', why: 'deleting a shared branch' };
    if (rest[0] === 'stash' && ['drop', 'clear'].includes(rest[1] ?? '')) return { kind: 'irreversible', why: 'stashes are shared across worktrees' };
    if (rest[0] === 'worktree' && ['remove', 'prune'].includes(rest[1] ?? '')) return { kind: 'irreversible', why: 'worktrees are managed by agentboard' };
  }
  if (prog === 'rm' || prog === 'rmdir' || prog === 'unlink' || prog === 'shred' || prog === 'trash') {
    const targets = argv.slice(1).filter((a) => !a.startsWith('-'));
    if (unresolved) return { kind: 'irreversible', why: `${prog} with variables/globs cannot be verified` };
    for (const t of targets) {
      const abs = path.resolve(ctx.cwd, expandHome(t));
      if (!within(abs, ctx.writableRoots)) return { kind: 'irreversible', why: `${prog} ${t} is outside your workspace` };
    }
    return { kind: 'ok', why: '' };
  }
  if (prog === 'find' && argv.includes('-delete')) {
    const roots = argv.slice(1).filter((a) => !a.startsWith('-')).slice(0, 1);
    const root = path.resolve(ctx.cwd, expandHome(roots[0] ?? '.'));
    if (unresolved || !within(root, ctx.writableRoots)) return { kind: 'irreversible', why: 'find -delete outside your workspace' };
  }
  if ((prog === 'mv' || prog === 'cp') && argv.length > 2) {
    const dest = argv[argv.length - 1];
    const abs = path.resolve(ctx.cwd, expandHome(dest));
    if (prog === 'mv' && !within(abs, ctx.writableRoots)) return { kind: 'irreversible', why: 'moving files outside your workspace' };
  }
  if (prog === 'curl' || prog === 'wget' || prog === 'http' || prog === 'httpie') {
    const rest = argv.slice(1).join(' ');
    if (/(-X|--request)\s*(POST|PUT|PATCH|DELETE)\b|(^|\s)(-d|--data[a-z-]*|-F|--form|--upload-file|-T)(\s|=|$)/i.test(rest)) {
      const urls = argv.filter((a) => /^https?:\/\//.test(a));
      if (!urls.every((u) => /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(u)))
        return { kind: 'irreversible', why: `${prog} sends data to a remote server` };
    }
  }
  return { kind: 'ok', why: '' };
}

export function classifyCommand(cmd: string, ctx: FloorContext, depth = 0): { kind: 'irreversible' | 'notify' | 'nested' | 'ok'; why: string } {
  const parts = splitCommands(cmd);
  // "curl ... | sh" style: a download piped into a shell
  if (/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b/.test(cmd)) return { kind: 'irreversible', why: 'piping a download into a shell' };
  let worst: { kind: 'irreversible' | 'notify' | 'nested' | 'ok'; why: string } = { kind: 'ok', why: '' };
  const rank = { ok: 0, irreversible: 1, nested: 2, notify: 3 } as const;
  for (const p of parts) {
    const r = classifySimple(p.argv, p.unresolved, ctx, depth);
    if (rank[r.kind] > rank[worst.kind]) worst = r;
  }
  return worst;
}

/** Simple permission-rule matcher for grants: "Tool", "Tool(prefix*)", "Bash(exact)". */
export function ruleMatches(rule: string, toolName: string, toolInput: Record<string, unknown>): boolean {
  const m = /^([A-Za-z0-9_]+)(?:\((.*)\))?$/.exec(rule.trim());
  if (!m) return false;
  const [, tool, spec] = m;
  if (tool !== toolName && !(tool.endsWith('__') && toolName.startsWith(tool))) return false;
  if (spec === undefined) return true;
  const subject = String(toolInput.command ?? toolInput.file_path ?? toolInput.path ?? toolInput.url ?? '');
  if (spec.endsWith('*')) return subject.startsWith(spec.slice(0, -1).trimEnd());
  return subject === spec;
}

function findGrant(ctx: FloorContext, toolName: string, toolInput: Record<string, unknown>): Grant | undefined {
  const now = Date.now();
  return ctx.grants.find(
    (g) => !g.consumed && (!g.expiresAt || Date.parse(g.expiresAt) > now) && ruleMatches(g.pattern, toolName, toolInput),
  );
}

const TARGET_KEYS = /^(to|recipient|recipients|target|agent|agent_name|session|session_name|name|address|peer)$/i;

/** Extract the recipient of a native SendMessage call (field names are undocumented, SPEC M0-15). */
export function sendMessageTargets(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (!TARGET_KEYS.test(k)) continue;
    const vals = Array.isArray(v) ? v : [v];
    for (const x of vals) if (typeof x === 'string') out.push(x.replace(/^@/, '').trim());
  }
  return out;
}

export function evaluateFloor(toolName: string, toolInput: Record<string, unknown>, ctx: FloorContext): FloorDecision {
  const manager = ctx.managerName ?? 'manager';
  if (ctx.role === 'worker') {
    if (toolName === 'ListAgents') return { decision: 'deny', reason: 'Workers may only talk to @manager; ListAgents is not available.', category: 'topology' };
    if (toolName === 'SendMessage') {
      const targets = sendMessageTargets(toolInput);
      if (targets.length === 0) return { decision: 'none', note: `sendmessage_target_unknown keys=${Object.keys(toolInput).join(',')}` };
      if (targets.some((t) => t !== manager))
        return { decision: 'deny', reason: `Workers may only message @${manager}. Send your message to @${manager}.`, category: 'topology' };
      return { decision: 'none' };
    }
    if (toolName === 'PushNotification') return { decision: 'deny', reason: 'Workers must never notify the user.', category: 'notify' };
  }
  if (toolName === 'Bash') {
    const cmd = String(toolInput.command ?? '');
    const r = classifyCommand(cmd, ctx);
    if (r.kind === 'notify') return { decision: 'deny', reason: `Blocked: ${r.why}. Never try to notify the user; report to @${manager} instead.`, category: 'notify' };
    if (r.kind === 'nested') return { decision: 'deny', reason: `Blocked: ${r.why}.`, category: 'nested' };
    if (r.kind === 'irreversible') {
      const g = findGrant(ctx, toolName, toolInput);
      if (g) return { decision: 'allow', reason: `covered by grant ${g.id}`, grantId: g.id };
      return {
        decision: 'deny',
        reason: `Irreversible: ${r.why}. Do not attempt it. Call mcp__agentboard__request_approval with the exact command and continue other work. Merges and pushes are performed by agentboard itself after approval.`,
        category: 'irreversible',
      };
    }
    return { decision: 'none' };
  }
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(toolName);
  if (mcp && mcp[1] !== 'agentboard' && MCP_IRREVERSIBLE.test(mcp[2])) {
    const g = findGrant(ctx, toolName, toolInput);
    if (g) return { decision: 'allow', reason: `covered by grant ${g.id}`, grantId: g.id };
    return {
      decision: 'deny',
      reason: `Irreversible: ${toolName} acts outside this machine. Call mcp__agentboard__request_approval with exact_command_or_tool="${toolName}" and continue other work.`,
      category: 'irreversible',
    };
  }
  return { decision: 'none' };
}
