// Known interactive dialogs that block a freshly spawned session (SPEC §18.1, §18.7).
// Each has a detector over the visible screen text and the keys that accept it.
export interface DialogRule {
  id: string;
  detect: RegExp;
  keys: string[]; // sent in order, ~300 ms apart
  /** if true, never auto-answer: the user must act (raise "dialog needs you") */
  userOnly?: boolean;
}

export const DIALOGS: DialogRule[] = [
  // Default selection is "No, exit" (verified on v2.1.328): move down, then confirm.
  { id: 'trust', detect: /Yes, I trust this folder/, keys: ['\x1b[B', '\r'] },
  { id: 'dev-channels', detect: /Loading development channels[\s\S]*server:agentboard/, keys: ['\r'] },
  { id: 'onboarding-theme', detect: /Choose the text style that looks best with your terminal/, keys: ['\r'], userOnly: true },
  { id: 'login', detect: /(Select login method|Log in with your Claude account|Paste code here)/i, keys: [], userOnly: true },
  { id: 'bypass-confirm', detect: /Bypass Permissions mode/i, keys: [], userOnly: true },
];

export function detectDialog(screen: string): DialogRule | undefined {
  return DIALOGS.find((d) => d.detect.test(screen));
}

/** Prompt is ready: the input box with "❯" and no blocking dialog. */
export function looksReady(screen: string): boolean {
  return /^\s*❯\s*$/m.test(screen) && !detectDialog(screen);
}

export const LIMIT_PATTERNS: RegExp[] = [
  /usage limit reached/i,
  /You've (hit|reached) your (usage|session|weekly) limit/i,
  /limit (will )?resets? (at|in)/i,
  /rate[_ ]limit(ed)?/i,
];
