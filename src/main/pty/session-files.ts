import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Paths {
  home: string; // AB_HOME, e.g. ~/agentboard
  resources: string; // dir containing bin/ and prompts/
}

export function abPaths(home: string) {
  return {
    events: path.join(home, 'events.jsonl'),
    board: path.join(home, 'board.md'),
    config: path.join(home, 'config.json'),
    repos: path.join(home, 'repos.json'),
    mcpCatalog: path.join(home, 'mcp-catalog.json'),
    manager: path.join(home, 'manager'),
    tasks: path.join(home, 'tasks'),
    sessions: path.join(home, 'sessions'),
    worktrees: path.join(home, 'worktrees'),
    workspaces: path.join(home, 'workspaces'),
    skillBackups: path.join(home, 'skill-backups'),
    logs: path.join(home, 'logs'),
    shims: path.join(home, 'bin', 'shims'),
  };
}

/** Express an absolute path in Claude Code permission-rule form. */
export function rulePath(p: string): string {
  const home = os.homedir();
  if (p === home || p.startsWith(home + path.sep)) return '~' + p.slice(home.length);
  return '/' + p; // "//abs" = absolute in Claude Code path rules
}

const HOOK_EVENTS: [string, string, string][] = [
  // [Claude Code event, ab-hook route, matcher]
  ['PreToolUse', 'pre-tool-use', '*'],
  ['PermissionRequest', 'permission-request', '*'],
  ['PostToolUse', 'post-tool-use', '*'],
  ['Notification', 'notification', '*'],
  ['UserPromptSubmit', 'user-prompt-submit', '*'],
  ['Stop', 'stop', '*'],
  ['StopFailure', 'stop-failure', '*'],
  ['SessionStart', 'session-start', '*'],
  ['SessionEnd', 'session-end', '*'],
];

export function hooksConfig(resources: string): Record<string, unknown> {
  const hook = path.join(resources, 'bin', 'ab-hook');
  const out: Record<string, unknown> = {};
  for (const [ev, route, matcher] of HOOK_EVENTS) {
    out[ev] = [
      {
        matcher,
        hooks: [{ type: 'command', command: `${shq(hook)} ${route}`, timeout: ev === 'PermissionRequest' ? 45 : 15 }],
      },
    ];
  }
  return out;
}

export function shq(s: string): string {
  return /^[A-Za-z0-9_\-./:@%+=]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface WorkerSettingsInput {
  home: string;
  resources: string;
  extraAllow?: string[];
  repoAllowBash?: string[];
}

export const WORKER_ALLOW = [
  'Read',
  'Glob',
  'Grep',
  'Skill',
  'WebSearch',
  'SendMessage',
  'mcp__agentboard',
  'Bash(git status *)',
  'Bash(git status)',
  'Bash(git diff *)',
  'Bash(git diff)',
  'Bash(git log *)',
  'Bash(git show *)',
  'Bash(git add *)',
  'Bash(git commit *)',
  'Bash(git checkout -b *)',
  'Bash(git switch *)',
  'Bash(git restore *)',
  'Bash(ls *)',
  'Bash(ls)',
  'Bash(cat *)',
  'Bash(pwd)',
  'Bash(npm test *)',
  'Bash(npm test)',
];

export function workerDeny(home: string): string[] {
  const h = rulePath(home);
  return [
    'ListAgents',
    'PushNotification',
    'Bash(sudo *)',
    'Bash(rm -rf /*)',
    'Bash(git push *)',
    'Bash(git push)',
    'Bash(git merge *)',
    'Bash(git rebase *)',
    'Bash(git stash *)',
    'Bash(git branch -D *)',
    'Bash(git worktree *)',
    'Bash(osascript *)',
    'Bash(terminal-notifier *)',
    'Bash(afplay *)',
    'Bash(say *)',
    'Bash(open *)',
    'Bash(launchctl *)',
    'Bash(defaults *)',
    'Bash(claude *)',
    'Read(~/.ssh/**)',
    'Read(~/.aws/**)',
    'Read(~/.gnupg/**)',
    'Edit(~/.claude/**)',
    'Write(~/.claude/**)',
    `Read(${h}/events.jsonl)`,
    `Edit(${h}/**/events.jsonl)`,
    `Edit(${h}/sessions/**)`,
    `Write(${h}/sessions/**)`,
    `Edit(${h}/config.json)`,
    `Edit(${h}/repos.json)`,
  ];
}

export function workerSettings(i: WorkerSettingsInput): Record<string, unknown> {
  return {
    permissions: {
      defaultMode: 'acceptEdits',
      allow: [...WORKER_ALLOW, ...(i.repoAllowBash ?? []).map((c) => `Bash(${c})`), ...(i.extraAllow ?? [])],
      deny: workerDeny(i.home),
    },
    hooks: hooksConfig(i.resources),
    statusLine: { type: 'command', command: shq(path.join(i.resources, 'bin', 'ab-statusline')), refreshInterval: 30 },
    enableAllProjectMcpServers: false,
    crossSessionInbound: 'accept',
  };
}

export function managerSettings(i: { home: string; resources: string }): Record<string, unknown> {
  return {
    permissions: {
      defaultMode: 'default',
      allow: [
        'Read',
        'Glob',
        'Grep',
        'Skill',
        'WebSearch',
        'SendMessage',
        'ListAgents',
        'mcp__agentboard',
        'Bash(git status *)',
        'Bash(git log *)',
        'Bash(git diff *)',
        'Bash(git show *)',
        'Bash(git branch)',
        'Bash(ls *)',
        'Bash(cat *)',
        'Bash(pwd)',
      ],
      deny: ['Edit', 'Write', 'NotebookEdit', 'PushNotification', 'Bash(git push *)', 'Bash(git merge *)', 'Bash(rm *)', 'Bash(sudo *)', 'Bash(osascript *)', 'Bash(claude *)'],
    },
    hooks: hooksConfig(i.resources),
    statusLine: { type: 'command', command: shq(path.join(i.resources, 'bin', 'ab-statusline')), refreshInterval: 30 },
    enableAllProjectMcpServers: false,
    crossSessionInbound: 'accept',
  };
}

export function mcpConfig(busUrl: string, extra: Record<string, unknown> = {}, channel = false): Record<string, unknown> {
  return {
    mcpServers: {
      agentboard: {
        type: 'http',
        url: `${busUrl}/mcp${channel ? '?channel=1' : ''}`,
        headers: { Authorization: 'Bearer ${AGENTBOARD_TOKEN}' },
      },
      ...extra,
    },
  };
}

/** Env allowlist: never inherit process.env wholesale (SPEC §18.3). */
export const ENV_ALLOW = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'SSH_AUTH_SOCK',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'https_proxy',
  'http_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
];

export function buildEnv(opts: {
  base: NodeJS.ProcessEnv;
  path: string;
  role: 'manager' | 'worker';
  session: string;
  name: string;
  token: string;
  busUrl: string;
  shimsDir?: string;
  worker?: string;
  task?: string;
  configDir?: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOW) {
    const v = opts.base[k];
    if (v !== undefined) env[k] = v;
  }
  const noProxy = ['127.0.0.1', 'localhost', opts.base.NO_PROXY ?? opts.base.no_proxy].filter(Boolean).join(',');
  Object.assign(env, {
    PATH: opts.role === 'worker' && opts.shimsDir ? `${opts.shimsDir}:${opts.path}` : opts.path,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'agentboard',
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
    MCP_TOOL_TIMEOUT: '120000',
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    AGENTBOARD_ROLE: opts.role,
    AGENTBOARD_SESSION: opts.session,
    AGENTBOARD_NAME: opts.name,
    AGENTBOARD_TOKEN: opts.token,
    AGENTBOARD_BUS_URL: opts.busUrl,
  });
  if (opts.worker) env.AGENTBOARD_WORKER = opts.worker;
  if (opts.task) env.AGENTBOARD_TASK = opts.task;
  if (opts.configDir) env.CLAUDE_CONFIG_DIR = opts.configDir;
  return env;
}

export function writeSessionFiles(dir: string, files: { settings: unknown; mcp: unknown; systemAppend: string }): { settings: string; mcp: string; systemAppend: string } {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = {
    settings: path.join(dir, 'settings.json'),
    mcp: path.join(dir, 'mcp.json'),
    systemAppend: path.join(dir, 'system-append.md'),
  };
  fs.writeFileSync(out.settings, JSON.stringify(files.settings, null, 2), { mode: 0o600 });
  fs.writeFileSync(out.mcp, JSON.stringify(files.mcp, null, 2), { mode: 0o600 });
  fs.writeFileSync(out.systemAppend, files.systemAppend, { mode: 0o600 });
  return out;
}

export function claudeArgs(o: {
  sessionId: string;
  resume: boolean;
  name: string;
  model?: string;
  permissionMode: string;
  files: { settings: string; mcp: string; systemAppend: string };
  addDirs?: string[];
  channel?: boolean;
  startPrompt?: string;
}): string[] {
  const a: string[] = o.resume ? ['--resume', o.sessionId] : ['--session-id', o.sessionId];
  a.push('--name', o.name);
  if (o.model) a.push('--model', o.model);
  a.push('--permission-mode', o.permissionMode);
  a.push('--settings', o.files.settings, '--setting-sources', 'project,local');
  a.push('--mcp-config', o.files.mcp, '--strict-mcp-config');
  a.push('--append-system-prompt-file', o.files.systemAppend);
  for (const d of o.addDirs ?? []) a.push('--add-dir', d);
  if (o.channel) a.push('--dangerously-load-development-channels', 'server:agentboard');
  // `--add-dir` and `--dangerously-load-development-channels` are variadic: without `--` the CLI
  // swallows the prompt as another dir / channel entry (and rejects it as an untagged channel).
  if (o.startPrompt) a.push('--', o.startPrompt);
  return a;
}
