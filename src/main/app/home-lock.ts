import fs from 'node:fs';
import path from 'node:path';

/**
 * One agentboard per AB_HOME. Electron's single-instance lock is keyed to userData, which
 * differs between launch styles (installed app, `npm run dev`, `electron out/main`), so it
 * cannot stop two instances from sharing ~/agentboard and both starting a manager.
 */
export function acquireHomeLock(home: string): { ok: true; release: () => void } | { ok: false; pid: number } {
  const file = path.join(home, 'agentboard.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return {
        ok: true,
        release: () => {
          try {
            if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file);
          } catch {
            /* already gone */
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(file, 'utf8').trim());
      if (pid && pid !== process.pid && isAlive(pid)) return { ok: false, pid };
      fs.rmSync(file, { force: true }); // stale lock from a crash
    }
  }
  return { ok: false, pid: -1 };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
