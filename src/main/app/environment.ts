import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ClaudeEnv {
  loginPath: string;
  claudePath?: string;
  claudeVersion?: string;
  missingFlags: string[];
}

/** Flags agentboard needs that ARE listed in `claude --help` (hidden ones are verified at onboarding). SPEC §18.1. */
export const VISIBLE_FLAGS = ['--session-id', '--resume', '--name', '--model', '--permission-mode', '--settings', '--setting-sources', '--mcp-config', '--strict-mcp-config', '--add-dir'];
export const MIN_CLAUDE_VERSION = [2, 1, 224];

function run(file: string, args: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (_err, stdout) => resolve(stdout?.toString() ?? ''));
  });
}

/** GUI apps get a minimal PATH; resolve the user's login-shell PATH once at boot (SPEC §18.3). */
export async function resolveClaude(override?: string): Promise<ClaudeEnv> {
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  const marker = '__AB_PATH__';
  const out = await run(shell, ['-l', '-i', '-c', `printf '${marker}%s${marker}\\n' "$PATH"; command -v claude`]);
  const m = new RegExp(`${marker}(.*)${marker}`).exec(out);
  const loginPath = m?.[1] || process.env.PATH || '/usr/bin:/bin';
  let claudePath = override ?? out
    .split('\n')
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith('/') && l.endsWith('claude'));
  if (!claudePath) {
    for (const p of [...loginPath.split(':'), path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin']) {
      const c = path.join(p, 'claude');
      if (fs.existsSync(c)) {
        claudePath = c;
        break;
      }
    }
  }
  const env: ClaudeEnv = { loginPath, claudePath, missingFlags: [] };
  if (!claudePath) return env;
  const version = (await run(claudePath, ['--version'])).trim();
  env.claudeVersion = version.split(/\s+/)[0];
  const help = await run(claudePath, ['--help']);
  env.missingFlags = VISIBLE_FLAGS.filter((f) => !help.includes(f));
  return env;
}

export function versionOk(v: string | undefined): boolean {
  if (!v) return false;
  const parts = v.split('.').map((x) => parseInt(x, 10));
  for (let i = 0; i < 3; i++) {
    if ((parts[i] ?? 0) > MIN_CLAUDE_VERSION[i]) return true;
    if ((parts[i] ?? 0) < MIN_CLAUDE_VERSION[i]) return false;
  }
  return true;
}

/** LaunchAgent that relaunches agentboard if it crashes (SPEC §12.4). macOS only. */
export function installLaunchAgent(execPath: string): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const file = path.join(dir, 'app.agentboard.plist');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>app.agentboard</string>
  <key>ProgramArguments</key><array><string>${execPath}</string><string>--background</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>ThrottleInterval</key><integer>10</integer>
</dict>
</plist>
`;
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== plist) fs.writeFileSync(file, plist);
  return file;
}
