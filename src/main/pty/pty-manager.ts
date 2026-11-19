import { EventEmitter } from 'node:events';
import * as XH from '@xterm/headless';
import type { IPty } from 'node-pty';
import { OutputFilter, stripAnsi } from './filters';
import { detectDialog, looksReady, type DialogRule } from './dialogs';

type HeadlessTerminal = {
  write(data: string, cb?: () => void): void;
  resize(cols: number, rows: number): void;
  buffer: { active: { length: number; baseY: number; cursorY: number; getLine(i: number): { translateToString(trim?: boolean): string } | undefined } };
  dispose(): void;
};
const TerminalCtor: new (o: Record<string, unknown>) => HeadlessTerminal =
  (XH as unknown as { Terminal?: unknown }).Terminal as never ?? (XH as unknown as { default: { Terminal: never } }).default.Terminal;

export interface SpawnOptions {
  session: string;
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
}

export type PtyFactory = (file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }) => IPty;

const RING_LIMIT = 2 * 1024 * 1024;
const PASTE_SUBMIT_DELAY_MS = 150;
const TYPING_QUIET_MS = 3000;

/**
 * One live claude PTY with: output filtering, a headless screen mirror (dialog/readiness
 * detection, tails), a replay ring for the renderer, user-typing tracking and injection.
 */
export class PtySession extends EventEmitter {
  readonly filter = new OutputFilter();
  private mirror: HeadlessTerminal;
  private ring: string[] = [];
  private ringBytes = 0;
  private dialogTimer?: NodeJS.Timeout;
  private answered = new Map<string, number>();
  private readyEmitted = false;
  private lastKeyAt = 0;
  private unsentTyping = false;
  private typed = '';
  readonly userLines: string[] = [];
  exited = false;
  cols: number;
  rows: number;

  constructor(
    readonly session: string,
    private readonly pty: IPty,
    cols: number,
    rows: number,
  ) {
    super();
    this.cols = cols;
    this.rows = rows;
    this.mirror = new TerminalCtor({ cols, rows, scrollback: 2000, allowProposedApi: true });
    pty.onData((raw) => this.onData(raw));
    pty.onExit(({ exitCode, signal }) => {
      this.exited = true;
      if (this.dialogTimer) clearTimeout(this.dialogTimer);
      this.emit('exit', { exitCode, signal });
      this.mirror.dispose();
    });
  }

  get pid(): number {
    return this.pty.pid;
  }

  private onData(raw: string): void {
    const data = this.filter.push(raw);
    if (!data) return;
    this.ring.push(data);
    this.ringBytes += data.length;
    while (this.ringBytes > RING_LIMIT && this.ring.length > 1) this.ringBytes -= this.ring.shift()!.length;
    this.mirror.write(data);
    this.emit('data', data);
    if (this.dialogTimer) clearTimeout(this.dialogTimer);
    this.dialogTimer = setTimeout(() => this.checkScreen(), 400);
  }

  /** Visible screen + recent scrollback as plain text. */
  screen(lines = 60): string {
    const b = this.mirror.buffer.active;
    const out: string[] = [];
    const start = Math.max(0, b.length - lines);
    for (let i = start; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
    return out.join('\n').replace(/\n+$/, '');
  }

  tail(lines = 100): string {
    return stripAnsi(this.screen(lines))
      .split('\n')
      .filter((l) => l.trim())
      .join('\n');
  }

  replay(): string {
    return this.ring.join('');
  }

  private checkScreen(): void {
    if (this.exited) return;
    const scr = this.screen(this.rows + 5);
    const d = detectDialog(scr);
    if (d) {
      this.handleDialog(d);
      return;
    }
    if (!this.readyEmitted && looksReady(scr)) {
      this.readyEmitted = true;
      this.emit('ready');
    }
  }

  private handleDialog(d: DialogRule): void {
    const n = this.answered.get(d.id) ?? 0;
    if (d.userOnly || n >= 2) {
      this.emit('dialog', { id: d.id, needsUser: true });
      return;
    }
    this.answered.set(d.id, n + 1);
    this.emit('dialog', { id: d.id, needsUser: false });
    void this.sendKeys(d.keys);
  }

  async sendKeys(keys: string[], gapMs = 300): Promise<void> {
    for (const k of keys) {
      if (this.exited) return;
      this.pty.write(k);
      await new Promise((r) => setTimeout(r, gapMs));
    }
  }

  /** Input typed by the user in the renderer tab. */
  userInput(data: string): void {
    if (this.exited) return;
    this.lastKeyAt = Date.now();
    this.trackTyping(data);
    this.pty.write(data);
  }

  private trackTyping(data: string): void {
    // cursor keys / other escape sequences don't change the tracked line
    if (data.startsWith('\x1b') && !data.startsWith('\x1b[200~')) return;
    const text = data.replace(/\x1b\[200~|\x1b\[201~/g, '');
    for (const ch of text) {
      if (ch === '\r' || ch === '\n') {
        const line = this.typed.trim();
        if (line) {
          this.userLines.push(line);
          if (this.userLines.length > 50) this.userLines.shift();
        }
        this.typed = '';
        this.unsentTyping = false;
      } else if (ch === '\x7f' || ch === '\b') {
        this.typed = this.typed.slice(0, -1);
      } else if (ch === '\x03' || ch === '\x15') {
        this.typed = '';
        this.unsentTyping = false;
      } else if (ch >= ' ') {
        this.typed += ch;
        this.unsentTyping = true;
      }
    }
  }

  /** True while the user is (or was recently) typing in this tab. */
  userActive(now = Date.now()): boolean {
    return this.unsentTyping || now - this.lastKeyAt < TYPING_QUIET_MS;
  }

  /** Inject text as a bracketed paste, then submit. Caller checks idle/userActive. */
  async injectPaste(text: string): Promise<void> {
    if (this.exited) throw new Error('session exited');
    const safe = text.replace(/\x1b/g, '').replace(/\r\n?/g, '\n');
    this.pty.write('\x1b[200~' + safe + '\x1b[201~');
    await new Promise((r) => setTimeout(r, PASTE_SUBMIT_DELAY_MS));
    this.pty.write('\r');
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    this.cols = cols;
    this.rows = rows;
    this.pty.resize(cols, rows);
    this.mirror.resize(cols, rows);
  }

  kill(signal?: string): void {
    if (!this.exited) this.pty.kill(signal);
  }
}

export class PtyManager extends EventEmitter {
  readonly sessions = new Map<string, PtySession>();

  constructor(private readonly factory: PtyFactory) {
    super();
  }

  spawn(o: SpawnOptions): PtySession {
    const cols = o.cols ?? 120;
    const rows = o.rows ?? 34;
    const p = this.factory(o.file, o.args, { name: 'xterm-256color', cols, rows, cwd: o.cwd, env: o.env });
    const s = new PtySession(o.session, p, cols, rows);
    this.sessions.set(o.session, s);
    s.on('exit', () => {
      if (this.sessions.get(o.session) === s) this.sessions.delete(o.session);
    });
    this.emit('spawned', s);
    return s;
  }

  get(session: string): PtySession | undefined {
    return this.sessions.get(session);
  }

  killAll(): void {
    for (const s of this.sessions.values()) s.kill();
  }
}
