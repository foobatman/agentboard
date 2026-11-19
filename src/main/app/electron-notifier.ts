import { app, Notification, type Tray } from 'electron';
import type { Notifier, OsNotification } from '../notify/notification-service';

/**
 * Electron implementation of Notifier. Imported ONLY by notify wiring in index.ts;
 * every OS-visible signal goes through NotificationService (lint rule enforces).
 */
export class ElectronNotifier implements Notifier {
  private keep = new Set<Notification>();
  constructor(private readonly tray: () => Tray | undefined) {}

  show(n: OsNotification, onClick: () => void): Promise<{ ok: boolean; error?: string }> {
    if (!Notification.isSupported()) return Promise.resolve({ ok: false, error: 'notifications not supported' });
    return new Promise((resolve) => {
      const notif = new Notification({ title: n.title, body: n.body, silent: false });
      this.keep.add(notif);
      let settled = false;
      const done = (r: { ok: boolean; error?: string }) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      notif.on('show', () => done({ ok: true }));
      notif.on('failed', (_e, error) => done({ ok: false, error }));
      notif.on('click', () => {
        onClick();
        this.keep.delete(notif);
      });
      notif.on('close', () => this.keep.delete(notif));
      notif.show();
      // 'show' is not guaranteed on every platform; treat no failure within 3 s as shown
      setTimeout(() => done({ ok: true }), 3000);
    });
  }

  setCounts(c: { open: number; snoozed: number; urgent: number }): void {
    if (process.platform === 'darwin') {
      app.dock?.setBadge(c.open > 0 ? String(c.open) : '');
    }
    app.setBadgeCount(c.open);
    const t = this.tray();
    if (t) {
      if (process.platform === 'darwin') t.setTitle(c.open || c.snoozed ? `${c.open}${c.snoozed ? ` · ${c.snoozed} later` : ''}` : '', { fontType: 'monospacedDigit' });
      t.setToolTip(`agentboard — ${c.open} open${c.urgent ? ` (${c.urgent} urgent)` : ''}${c.snoozed ? `, ${c.snoozed} later` : ''}`);
    }
  }

  bounceCritical(): void {
    if (process.platform === 'darwin') app.dock?.bounce('critical');
  }
}
