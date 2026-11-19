import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulid';
import type { DraftEvent, EventEnvelope } from '../../shared/events';

export class DiskFullError extends Error {
  code = 'DISK_FULL';
}

export class LogIntegrityError extends Error {
  constructor(message: string, readonly line: number) {
    super(message);
  }
}

export interface LoadResult {
  events: EventEnvelope[];
  tornBytes: number;
  quarantineFile?: string;
}

/**
 * Append-only JSONL event log. Single writer; group commit: events queued while a
 * write+datasync is in flight are written together with one datasync. Callers must
 * not perform side effects before `append()` resolves (SPEC §4.2, §18.8).
 */
export class EventStore {
  private fh?: fsp.FileHandle;
  private seq = 0;
  private queue: { lines: string; resolve: () => void; reject: (e: unknown) => void }[] = [];
  private flushing = false;
  private readOnly = false;

  constructor(
    readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Read and validate the log; repair a torn final line. Must be called before open(). */
  load(): LoadResult {
    if (!fs.existsSync(this.file)) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      return { events: [], tornBytes: 0 };
    }
    const buf = fs.readFileSync(this.file);
    const events: EventEnvelope[] = [];
    let tornBytes = 0;
    let quarantineFile: string | undefined;

    let lastGoodEnd = 0; // byte offset after the last good '\n'
    let offset = 0;
    let lineNo = 0;
    while (offset < buf.length) {
      const nl = buf.indexOf(0x0a, offset);
      const isLast = nl === -1;
      const end = isLast ? buf.length : nl;
      const lineBuf = buf.subarray(offset, end);
      lineNo++;
      const restIsEmpty = isLast || buf.subarray(nl + 1).toString('utf8').trim() === '';
      let parsed: EventEnvelope | undefined;
      try {
        if (lineBuf.length > 0) parsed = JSON.parse(lineBuf.toString('utf8'));
      } catch {
        parsed = undefined;
      }
      if (isLast) {
        // final line without newline: torn unless it is empty
        if (lineBuf.length > 0) {
          tornBytes = buf.length - lastGoodEnd;
        }
        break;
      }
      if (!parsed) {
        if (lineBuf.length === 0) {
          offset = nl + 1;
          lastGoodEnd = offset;
          continue;
        }
        if (restIsEmpty) {
          // last complete line is garbage (e.g. partially flushed) -> treat as torn
          tornBytes = buf.length - lastGoodEnd;
          break;
        }
        throw new LogIntegrityError(`corrupt event log line ${lineNo} in ${this.file}`, lineNo);
      }
      if (parsed.seq !== events.length + 1) {
        throw new LogIntegrityError(`sequence gap at line ${lineNo}: expected ${events.length + 1}, got ${parsed.seq}`, lineNo);
      }
      events.push(parsed);
      offset = nl + 1;
      lastGoodEnd = offset;
    }
    if (tornBytes > 0) {
      quarantineFile = `${this.file.replace(/\.jsonl$/, '')}.torn-${Date.now()}.bin`;
      fs.writeFileSync(quarantineFile, buf.subarray(lastGoodEnd));
      fs.truncateSync(this.file, lastGoodEnd);
    }
    this.seq = events.length;
    return { events, tornBytes, quarantineFile };
  }

  async open(): Promise<void> {
    this.fh = await fsp.open(this.file, 'a', 0o600);
  }

  get lastSeq(): number {
    return this.seq;
  }

  get isReadOnly(): boolean {
    return this.readOnly;
  }

  /** Assign seq/id/ts and durably append. Resolves only after datasync. */
  async append(drafts: DraftEvent[]): Promise<EventEnvelope[]> {
    if (!this.fh) throw new Error('EventStore not open');
    if (this.readOnly) throw new DiskFullError('event log is read-only (disk full)');
    if (drafts.length === 0) return [];
    const ts = new Date(this.now()).toISOString();
    const envs: EventEnvelope[] = drafts.map((d) => ({
      v: 1,
      seq: ++this.seq,
      id: ulid(),
      ts,
      type: d.type,
      actor: d.actor,
      data: d.data,
    })) as EventEnvelope[];
    const lines = envs.map((e) => JSON.stringify(e)).join('\n') + '\n';
    try {
      await new Promise<void>((resolve, reject) => {
        this.queue.push({ lines, resolve, reject });
        void this.flush();
      });
    } catch (e) {
      // roll back the sequence counter: nothing was durably written for these events
      this.seq -= envs.length;
      throw e;
    }
    return envs;
  }

  private async flush(): Promise<void> {
    if (this.flushing || !this.fh) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.queue.length);
        const data = batch.map((b) => b.lines).join('');
        try {
          await this.fh.write(data);
          await this.fh.datasync();
          for (const b of batch) b.resolve();
        } catch (e: unknown) {
          const err = e as NodeJS.ErrnoException;
          if (err.code === 'ENOSPC' || err.code === 'EDQUOT') {
            this.readOnly = true;
            for (const b of batch) b.reject(new DiskFullError(err.message));
            for (const b of this.queue.splice(0)) b.reject(new DiskFullError(err.message));
          } else {
            for (const b of batch) b.reject(e);
          }
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Try leaving read-only mode (called periodically after ENOSPC). */
  async probeWritable(): Promise<boolean> {
    if (!this.readOnly) return true;
    try {
      const probe = this.file + '.probe';
      await fsp.writeFile(probe, 'x');
      await fsp.unlink(probe);
      this.readOnly = false;
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.fh?.close();
    this.fh = undefined;
  }
}

export function newBootId(): string {
  return ulid();
}
