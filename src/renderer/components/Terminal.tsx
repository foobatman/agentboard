import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

/**
 * One xterm per session. Notification sequences are already stripped in main
 * (OutputFilter); these handlers are a second layer (SPEC §8 #2/#3).
 */
export function TerminalView({ session, visible }: { session: string; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);

  useEffect(() => {
    const term = new Terminal({
      fontFamily: 'Menlo, "SF Mono", Monaco, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 10000,
      macOptionIsMeta: true,
      allowProposedApi: true,
      theme: { background: '#0d0f12', foreground: '#d8dee9', cursor: '#d8dee9', selectionBackground: '#3b4252' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri)));
    for (const id of [9, 99, 777, 1337, 7501]) term.parser.registerOscHandler(id, () => true);
    term.onBell(() => {
      /* deliberately silent */
    });
    // app shortcuts (⌘N / Ctrl+N quick-add) are not sent to the session
    term.attachCustomKeyEventHandler((e) => !((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n'));
    term.open(host.current!);
    termRef.current = term;
    fitRef.current = fit;
    let disposed = false;
    void window.agentboard.ptyReplay(session).then((data) => {
      if (!disposed && data) term.write(data);
    });
    const off = window.agentboard.onPtyData((s, d) => {
      if (s === session) term.write(d);
    });
    const input = term.onData((d) => window.agentboard.ptyInput(session, d));
    const ro = new ResizeObserver(() => {
      if (!host.current?.offsetParent) return;
      try {
        fit.fit();
        window.agentboard.ptyResize(session, term.cols, term.rows);
      } catch {
        /* not laid out */
      }
    });
    ro.observe(host.current!);
    return () => {
      disposed = true;
      off();
      input.dispose();
      ro.disconnect();
      term.dispose();
    };
  }, [session]);

  useEffect(() => {
    if (visible) {
      setTimeout(() => {
        try {
          fitRef.current?.fit();
          const t = termRef.current;
          if (t) window.agentboard.ptyResize(session, t.cols, t.rows);
          t?.focus();
        } catch {
          /* ignore */
        }
      }, 30);
    }
  }, [visible, session]);

  return <div className="terminal" ref={host} style={{ display: visible ? 'block' : 'none' }} />;
}
