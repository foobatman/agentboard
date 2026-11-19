import { describe, expect, it } from 'vitest';
import { OutputFilter, stripAnsi } from '../../src/main/pty/filters';
import { detectDialog, looksReady } from '../../src/main/pty/dialogs';

describe('OutputFilter', () => {
  it('drops BEL and notification OSC sequences, keeps others', () => {
    const f = new OutputFilter();
    const out = f.push('a\x07b\x1b]9;done\x07c\x1b]777;notify;t;b\x1b\\d\x1b]8;;http://x\x07link\x1b]8;;\x07\x1b[31mred');
    expect(out).toBe('abcd\x1b]8;;http://x\x07link\x1b]8;;\x07\x1b[31mred');
    expect(f.counters.bel).toBe(1);
    expect(f.counters.osc).toEqual({ '9': 1, '777': 1 });
  });
  it('handles sequences split across chunks', () => {
    const f = new OutputFilter();
    const parts = ['x\x1b', ']9', ';hel', 'lo\x1b', '\\y', '\x1b]99;i=1:', 'p=body\x07z'];
    expect(parts.map((p) => f.push(p)).join('')).toBe('xyz');
    expect(f.counters.osc).toEqual({ '9': 1, '99': 1 });
  });
  it('strips ansi for tails', () => {
    expect(stripAnsi('\x1b[1mhi\x1b[0m \x1b]8;;u\x07x')).toBe('hi x');
  });
});

describe('dialogs', () => {
  it('detects the trust dialog and readiness', () => {
    expect(detectDialog('❯ No, exit\n  Yes, I trust this folder')?.id).toBe('trust');
    expect(looksReady('──────\n❯ \n──────')).toBe(true);
    expect(looksReady('❯ No, exit\n Yes, I trust this folder')).toBe(false);
  });
});
