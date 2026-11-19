// Streaming terminal-output filter (SPEC §8 #2–#4). Removes BEL bytes and notification
// OSC sequences (9, 99, 777, 1337, 7501) before data reaches any terminal emulator.
// Sequences may be split across chunks, so this is a small state machine.

const BLOCKED_OSC = new Set(['9', '99', '777', '1337', '7501']);
const ESC = 0x1b;
const BEL = 0x07;
const MAX_OSC = 64 * 1024;

export interface FilterCounters {
  bel: number;
  osc: Record<string, number>;
}

export class OutputFilter {
  private state: 'text' | 'esc' | 'osc' | 'osc_esc' = 'text';
  private osc = '';
  readonly counters: FilterCounters = { bel: 0, osc: {} };

  push(chunk: string): string {
    let out = '';
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      const c = chunk.charCodeAt(i);
      switch (this.state) {
        case 'text':
          if (c === ESC) this.state = 'esc';
          else if (c === BEL) this.counters.bel++;
          else out += ch;
          break;
        case 'esc':
          if (ch === ']') {
            this.state = 'osc';
            this.osc = '';
          } else {
            out += '\x1b' + ch;
            this.state = c === ESC ? 'esc' : 'text';
            if (c === ESC) out = out.slice(0, -1);
          }
          break;
        case 'osc':
          if (c === BEL) this.endOsc('\x07', (s) => (out += s));
          else if (c === ESC) this.state = 'osc_esc';
          else {
            this.osc += ch;
            if (this.osc.length > MAX_OSC) {
              // runaway sequence: drop it
              this.osc = '';
              this.state = 'text';
            }
          }
          break;
        case 'osc_esc':
          if (ch === '\\') this.endOsc('\x1b\\', (s) => (out += s));
          else {
            // ESC inside OSC that is not ST: treat as aborted OSC, re-process ESC
            this.osc = '';
            this.state = 'esc';
            i--;
          }
          break;
      }
    }
    return out;
  }

  private endOsc(terminator: string, emit: (s: string) => void): void {
    const ident = this.osc.split(';', 1)[0];
    if (BLOCKED_OSC.has(ident)) {
      this.counters.osc[ident] = (this.counters.osc[ident] ?? 0) + 1;
    } else {
      emit('\x1b]' + this.osc + terminator);
    }
    this.osc = '';
    this.state = 'text';
  }
}

/** Strip ANSI escape sequences (for tails shown to the manager and pattern matching). */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[@-_]/g, '');
}
