#!/usr/bin/env node
// `npm run dev` launcher. Chromium refuses to start as root on Linux unless the sandbox is
// disabled (e.g. containers/CI); macOS and normal Linux users are unaffected.
import { spawn } from 'node:child_process';

const args = ['dev', ...process.argv.slice(2)];
if (process.platform === 'linux' && process.getuid?.() === 0 && !args.includes('--noSandbox')) {
  console.warn('[agentboard] running as root on Linux: adding --noSandbox for Electron');
  args.push('--noSandbox');
}
if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  console.warn('[agentboard] no $DISPLAY: Electron needs a display (try `xvfb-run -a npm run dev` on a headless machine)');
}
const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron-vite', ...args], { stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
