/**
 * The rules Claude Code was given in a project, and rule files nearby that never load there.
 * Built from transcript structure and file locations; nothing is judged by a model. DECISIONS.md D71.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { projectKey } from './harness/claude-code.ts';
import type { Instruction } from './parsers/claude-code.ts';
import { redact } from './redact.ts';

/** One instruction file as it loaded across a project's sessions. Paths only: the text is never stored. */
export type LoadedRuleFile = {
  path: string;
  kind: string;
  sessions: number;
  /** Sessions it loaded in at the start; the rest loaded it later (a subfolder or path-scoped rule). */
  atStartSessions: number;
  firstAt: string;
  lastAt: string;
};

/** An auto-memory file on disk that does not load on its own in this project. */
export type MemoryFile = {
  path: string;
  /** The folder whose sessions load this memory. */
  folder: string;
  /** `on-demand`: this project's memory, loaded only when Claude opens it. `parent`: a parent folder's, never loaded here. */
  scope: 'on-demand' | 'parent';
  name?: string;
  description?: string;
  /** Frontmatter `type`; `feedback` is a rule the developer gave. */
  type?: string;
  /** Named in its folder's MEMORY.md index. */
  listed: boolean;
};

export type RuleCheck =
  | { kind: 'duplicate'; line: string; files: string[] }
  | { kind: 'missing-link'; file: string; target: string };

/** Per-file tallies from each session's loaded instructions. */
export function tallyLoaded(perSession: { at: string; instructions: Instruction[] }[]): LoadedRuleFile[] {
  const by = new Map<string, LoadedRuleFile & { seen: Set<number>; start: Set<number> }>();
  perSession.forEach((s, i) => {
    for (const ins of s.instructions) {
      const row = by.get(ins.path) ?? { path: ins.path, kind: ins.kind, sessions: 0, atStartSessions: 0, firstAt: s.at, lastAt: s.at, seen: new Set<number>(), start: new Set<number>() };
      row.seen.add(i);
      if (ins.atStart) row.start.add(i);
      if (s.at < row.firstAt) row.firstAt = s.at;
      if (s.at > row.lastAt) row.lastAt = s.at;
      by.set(ins.path, row);
    }
  });
  return [...by.values()]
    .map(({ seen, start, ...r }) => ({ ...r, sessions: seen.size, atStartSessions: start.size }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** The memory folder Claude Code keeps for sessions started in `folder`. */
export function memoryDir(folder: string, claudeDir: string): string {
  return join(claudeDir, 'projects', projectKey(folder), 'memory');
}

/** Frontmatter `name`, `description` and `type` (top level or under `metadata`). */
export function frontmatter(text: string): { name?: string; description?: string; type?: string } {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (m === null) return {};
  const body = m[1] as string;
  const field = (k: string): string | undefined => {
    const v = new RegExp(`^\\s*${k}:\\s*(.+)$`, 'm').exec(body)?.[1]?.trim();
    return v === undefined || v === '' ? undefined : v.replace(/^["']|["']$/g, '');
  };
  const name = field('name');
  const description = field('description');
  const type = field('type');
  return { ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }), ...(type === undefined ? {} : { type }) };
}

function readOr(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function memoryFilesIn(dir: string, folder: string, scope: MemoryFile['scope']): MemoryFile[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'MEMORY.md').sort();
  } catch {
    return [];
  }
  const index = readOr(join(dir, 'MEMORY.md')) ?? '';
  return names.map((n) => {
    const fm = frontmatter(readOr(join(dir, n)) ?? '');
    return { path: join(dir, n), folder, scope, ...fm, listed: index.includes(`(${n})`) };
  });
}

/**
 * Memory that does not load by itself in sessions started in `cwd`: this folder's memory files (only the
 * MEMORY.md index loads; a file loads when Claude opens it) and every parent folder's (never loaded here).
 */
export function nearbyMemory(cwd: string, claudeDir: string): MemoryFile[] {
  const out = memoryFilesIn(memoryDir(cwd, claudeDir), cwd, 'on-demand');
  for (let dir = dirname(cwd); dir !== dirname(dir); dir = dirname(dir)) {
    out.push(...memoryFilesIn(memoryDir(dir, claudeDir), dir, 'parent'));
  }
  return out;
}

/** A rule the developer gave that never loads here: a parent folder's feedback memory. */
export function notLoadedRules(memory: MemoryFile[]): MemoryFile[] {
  return memory.filter((m) => m.scope === 'parent' && m.type === 'feedback');
}

const norm = (l: string): string =>
  l.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Lines worth comparing: prose, not headings, fences, tables, frontmatter or short fragments. */
function ruleLines(text: string): string[] {
  const out: string[] = [];
  let fence = false;
  let front = text.startsWith('---\n');
  for (const [i, line] of text.split('\n').entries()) {
    if (front) {
      if (i > 0 && line.trim() === '---') front = false;
      continue;
    }
    if (line.trim().startsWith('```')) {
      fence = !fence;
      continue;
    }
    if (fence || /^\s*(#|\||<!--)/.test(line)) continue;
    const n = norm(line);
    if (n.length >= 24) out.push(n);
  }
  return out;
}

/** Local links and `@` imports in a file, as written. */
function localTargets(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) out.push(m[1] as string);
  for (const m of text.matchAll(/^@(\S+)/gm)) out.push(m[1] as string);
  return out.filter((t) => !/^[a-z][a-z0-9+.-]*:/i.test(t));
}

/** Facts about the files themselves; never a verdict on their wording (D45). */
export function structuralChecks(files: { path: string; text: string }[], exists: (p: string) => boolean = existsSync): RuleCheck[] {
  const where = new Map<string, Set<string>>();
  for (const f of files) {
    for (const l of new Set(ruleLines(f.text))) where.set(l, (where.get(l) ?? new Set<string>()).add(f.path));
  }
  const checks: RuleCheck[] = [...where.entries()]
    .filter(([, ps]) => ps.size > 1)
    .map(([line, ps]) => ({ kind: 'duplicate' as const, line, files: [...ps].sort() }));
  for (const f of files) {
    for (const t of new Set(localTargets(f.text))) {
      const p = t.startsWith('~/') ? join(homedir(), t.slice(2)) : resolve(dirname(f.path), t);
      if (!exists(p)) checks.push({ kind: 'missing-link', file: f.path, target: t });
    }
  }
  return checks;
}

/** The loaded files' current text, read now from disk; a file since deleted is left out. */
export function currentTexts(loaded: LoadedRuleFile[]): { path: string; text: string }[] {
  return loaded.flatMap((l) => {
    const text = readOr(l.path);
    return text === undefined ? [] : [{ path: l.path, text }];
  });
}

/** What the session-start line counts for one project. */
export function rulesCounts(cwd: string, claudeDir: string, loaded: LoadedRuleFile[]): { notLoaded: number; checks: number } {
  return { notLoaded: notLoadedRules(nearbyMemory(cwd, claudeDir)).length, checks: structuralChecks(currentTexts(loaded)).length };
}

/** A file's current lines for display: read now from disk, redacted, capped. Never stored. */
export function currentLines(path: string, max = 80): { lines: string[]; total: number } | undefined {
  const text = readOr(path);
  if (text === undefined) return undefined;
  const all = redact(text).text.split('\n');
  return { lines: all.slice(0, max), total: all.length };
}

/** A path the parser shortened to `~/…` (redaction does), expanded back for reading the disk. */
export function untilde(path: string, home: string = homedir()): string {
  return path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;
}

/** A path for display, with `~` for home. */
export function tilde(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path === home ? '~' : path;
}
