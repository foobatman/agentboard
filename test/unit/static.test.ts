// Static guard (SPEC §8 #11): only the notification module may raise OS-visible signals.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../../src');
const ALLOWED = new Set(['main/app/electron-notifier.ts', 'main/notify/notification-service.ts']);
const PATTERNS = [/new Notification\(/, /\.bounce\(/, /setBadge\(/, /setBadgeCount\(/, /shell\.beep\(/, /\bnew window\.Notification\b/, /Notification\.requestPermission/];

function walk(d: string): string[] {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
}

describe('notification discipline', () => {
  it('no module outside the notifier raises OS notifications, badges or bounces', () => {
    const offenders: string[] = [];
    for (const f of walk(SRC).filter((x) => /\.(ts|tsx)$/.test(x))) {
      const rel = path.relative(SRC, f);
      if (ALLOWED.has(rel)) continue;
      const text = fs.readFileSync(f, 'utf8');
      for (const p of PATTERNS) if (p.test(text)) offenders.push(`${rel}: ${p}`);
    }
    expect(offenders).toEqual([]);
  });
  it('the notification service only accepts attention/app origins', async () => {
    const { NotificationService, RecordingNotifier } = await import('../../src/main/notify/notification-service');
    const s = new NotificationService(new RecordingNotifier());
    await expect(s.notify('worker' as never, { id: 'x', title: 't', body: 'b', urgent: false })).rejects.toThrow(/refused/);
  });
});
