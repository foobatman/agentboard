import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface SkillInfo {
  name: string;
  description: string;
  whenToUse?: string;
  scope: 'user' | 'project';
  path: string;
  repo?: string;
  hasHooks: boolean;
}

/** Minimal YAML frontmatter reader for SKILL.md (flat keys; folded/quoted strings). */
export function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { fm: {}, body: text };
  const fm: Record<string, string> = {};
  let key = '';
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      fm[key] = kv[2].replace(/^["']|["']$/g, '').replace(/^[>|]-?$/, '');
    } else if (key && /^\s+/.test(line)) {
      fm[key] = (fm[key] ? fm[key] + ' ' : '') + line.trim();
    }
  }
  return { fm, body: m[2] };
}

export function skillDirs(repos: string[], claudeHome = path.join(os.homedir(), '.claude')): { dir: string; scope: 'user' | 'project'; repo?: string }[] {
  return [{ dir: path.join(claudeHome, 'skills'), scope: 'user' as const }, ...repos.map((r) => ({ dir: path.join(r, '.claude', 'skills'), scope: 'project' as const, repo: r }))];
}

export function scanSkills(repos: string[], claudeHome?: string): SkillInfo[] {
  const out: SkillInfo[] = [];
  const seen = new Set<string>();
  for (const { dir, scope, repo } of skillDirs(repos, claudeHome)) {
    if (!fs.existsSync(dir)) continue;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const file = path.join(dir, ent.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const { fm } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      const name = fm.name || ent.name;
      const key = `${scope}:${repo ?? ''}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, description: fm.description ?? '', whenToUse: fm.when_to_use, scope, path: file, repo, hasHooks: 'hooks' in fm });
    }
  }
  return out;
}

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;

export function writeSkill(o: {
  dir: string; // the skills/ directory
  name: string;
  description: string;
  body: string;
  update?: boolean;
  backupRoot: string;
}): { path: string; backup?: string } {
  if (!SKILL_NAME_RE.test(o.name)) throw Object.assign(new Error('invalid skill name'), { code: 'INVALID_ARGUMENT' });
  if (!o.description.trim()) throw Object.assign(new Error('description is required'), { code: 'INVALID_FRONTMATTER' });
  if (/^---/m.test(o.body.trimStart()) && /^hooks:/m.test(o.body)) throw Object.assign(new Error('skills written by the manager may not declare hooks'), { code: 'INVALID_FRONTMATTER' });
  if (o.body.split('\n').length > 400) throw Object.assign(new Error('skill body over 400 lines; move reference material into separate files'), { code: 'INVALID_ARGUMENT' });
  const skillDir = path.join(o.dir, o.name);
  const file = path.join(skillDir, 'SKILL.md');
  let backup: string | undefined;
  if (fs.existsSync(file)) {
    if (!o.update) throw Object.assign(new Error(`skill ${o.name} exists; pass update:true`), { code: 'EXISTS_NEEDS_UPDATE_FLAG' });
    backup = path.join(o.backupRoot, o.name, new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(backup, { recursive: true });
    fs.cpSync(skillDir, backup, { recursive: true });
  }
  fs.mkdirSync(skillDir, { recursive: true });
  const desc = o.description.replace(/\r?\n/g, ' ').replace(/"/g, '\\"');
  const body = o.body.replace(/^---[\s\S]*?---\s*/, '');
  fs.writeFileSync(file, `---\nname: ${o.name}\ndescription: "${desc}"\n---\n\n${body.trim()}\n`);
  return { path: file, backup };
}
