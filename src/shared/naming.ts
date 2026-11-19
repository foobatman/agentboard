// Worker naming rules (SPEC §6.9).
export const NAME_RE = /^[a-z][a-z0-9-]{2,23}$/;
export const RESERVED_NAMES = new Set(['manager', 'all', 'user', 'app', 'agentboard', 'system']);
const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'my', 'our', 'into', 'from', 'by', 'at', 'is', 'be', 'please', 'add', 'make', 'do']);

export function isValidName(name: string): boolean {
  return NAME_RE.test(name) && !RESERVED_NAMES.has(name) && !name.endsWith('-') && !name.includes('--');
}

export function slugify(text: string, maxWords = 3): string {
  const words = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((w) => w && !STOP.has(w));
  let s = words.slice(0, maxWords).join('-').slice(0, 24).replace(/-+$/, '');
  if (!/^[a-z]/.test(s)) s = `w-${s}`.replace(/-+$/, '');
  if (s.length < 3) s = (s + '-task').slice(0, 24);
  return s;
}

/** Validate a requested name (or derive one) and make it unique among `taken`. */
export function assignName(requested: string | undefined, title: string, taken: Set<string>): { name: string; error?: string } {
  let base = requested?.trim().toLowerCase();
  if (base && !isValidName(base)) {
    return { name: '', error: `invalid worker name "${requested}": use 3-24 chars [a-z0-9-], start with a letter, not reserved` };
  }
  if (!base) base = slugify(title);
  if (RESERVED_NAMES.has(base)) base = `${base}-task`;
  let name = base;
  for (let i = 2; taken.has(name); i++) {
    const suffix = `-${i}`;
    name = base.slice(0, 24 - suffix.length).replace(/-+$/, '') + suffix;
  }
  return { name };
}
