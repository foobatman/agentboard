// node-pty ships prebuilt `spawn-helper` binaries for macOS; some npm/pnpm
// installs lose the execute bit (node-pty issue #850) -> posix_spawnp failures.
import fs from 'node:fs';
import path from 'node:path';
const root = path.join(process.cwd(), 'node_modules', 'node-pty');
const dirs = [path.join(root, 'prebuilds'), path.join(root, 'build', 'Release')];
for (const d of dirs) {
  if (!fs.existsSync(d)) continue;
  for (const entry of fs.readdirSync(d, { recursive: true })) {
    const p = path.join(d, String(entry));
    if (path.basename(p) === 'spawn-helper' && fs.statSync(p).isFile()) {
      fs.chmodSync(p, 0o755);
      console.log('chmod 755', p);
    }
  }
}
