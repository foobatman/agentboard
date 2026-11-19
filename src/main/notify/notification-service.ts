// The ONLY module allowed to raise OS-visible signals (SPEC §8 #11, §18.7).
// Electron specifics live in an injected Notifier so this file is testable.

export type NotificationOrigin = 'attention' | 'app';

export interface OsNotification {
  id: string;
  title: string;
  body: string;
  urgent: boolean;
}

export interface Notifier {
  show(n: OsNotification, onClick: () => void): Promise<{ ok: boolean; error?: string }>;
  setCounts(c: { open: number; snoozed: number; urgent: number }): void;
  bounceCritical(): void;
}

export interface NotificationRecord {
  at: string;
  origin: NotificationOrigin;
  id: string;
  title: string;
  body: string;
  ok: boolean;
  error?: string;
}

/** macOS truncates notification text at ~256 bytes (Electron docs). */
export function clampBytes(text: string, max = 240): string {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= max) return text;
  let out = text;
  while (enc.encode(out + '…').length > max && out.length > 0) out = out.slice(0, -1);
  return out + '…';
}

export class NotificationService {
  readonly log: NotificationRecord[] = [];
  onClick: (id: string) => void = () => {};

  constructor(private readonly notifier: Notifier) {}

  async notify(origin: NotificationOrigin, n: OsNotification): Promise<{ ok: boolean; error?: string }> {
    if (origin !== 'attention' && origin !== 'app') {
      throw new Error(`refused notification from origin ${String(origin)}`);
    }
    const body = clampBytes(n.body);
    const title = clampBytes(n.title, 64);
    let res: { ok: boolean; error?: string };
    try {
      res = await this.notifier.show({ ...n, title, body }, () => this.onClick(n.id));
    } catch (e) {
      res = { ok: false, error: String(e) };
    }
    this.log.push({ at: new Date().toISOString(), origin, id: n.id, title, body, ok: res.ok, error: res.error });
    if (this.log.length > 500) this.log.shift();
    if (n.urgent) this.notifier.bounceCritical();
    return res;
  }

  setCounts(c: { open: number; snoozed: number; urgent: number }): void {
    this.notifier.setCounts(c);
  }
}

/** A Notifier that records only (tests, headless runs). */
export class RecordingNotifier implements Notifier {
  shown: OsNotification[] = [];
  counts = { open: 0, snoozed: 0, urgent: 0 };
  bounces = 0;
  fail = false;
  async show(n: OsNotification): Promise<{ ok: boolean; error?: string }> {
    if (this.fail) return { ok: false, error: 'simulated failure' };
    this.shown.push(n);
    return { ok: true };
  }
  setCounts(c: { open: number; snoozed: number; urgent: number }): void {
    this.counts = c;
  }
  bounceCritical(): void {
    this.bounces++;
  }
}
