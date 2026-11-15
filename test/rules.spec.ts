/** The Rules tab's data: what loaded, memory nearby that does not, and facts about the files (D71). */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { frontmatter, memoryDir, nearbyMemory, notLoadedRules, rulesCounts, structuralChecks, tallyLoaded, untilde } from '../src/rules.ts';
import { rulesLine, reportBlock } from '../src/session-block.ts';
import { rulesFor } from '../src/cmd/report.ts';
import { openStore, putRuleFiles, readRuleFiles } from '../src/store.ts';
import { projectKey } from '../src/harness/claude-code.ts';
import type { Instruction } from '../src/parsers/claude-code.ts';
import type { Standing } from '../src/standing.ts';

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p));
const ins = (path: string, atStart: boolean, kind = 'Project'): Instruction => ({ fromSeq: 0, source: 'x', text: 't', path, kind, atStart });
const memory = (dir: string, files: Record<string, string>): void => {
  mkdirSync(dir, { recursive: true });
  for (const [n, t] of Object.entries(files)) writeFileSync(join(dir, n), t);
};
const rule = (name: string, type = 'feedback'): string => `---\nname: ${name}\ndescription: ${name} in one line\nmetadata:\n  type: ${type}\n---\n\nBody of ${name}.\n`;

/** A home with a project at <home>/work/app, memory for it and for its parent <home>/work. */
function world(): { home: string; claude: string; cwd: string } {
  const home = tmp('rules-home-');
  const claude = join(home, '.claude');
  const cwd = join(home, 'work', 'app');
  mkdirSync(cwd, { recursive: true });
  memory(memoryDir(cwd, claude), { 'MEMORY.md': '- [Mine](mine.md) — mine\n', 'mine.md': rule('mine'), 'notes.md': rule('notes', 'project') });
  memory(memoryDir(join(home, 'work'), claude), { 'MEMORY.md': '- [Push](push.md) — push\n', 'push.md': rule('never-push'), 'ref.md': rule('ref', 'reference') });
  return { home, claude, cwd };
}

describe('what loaded', () => {
  it('tallies sessions per file, and which loaded at the start', () => {
    const t = tallyLoaded([
      { at: '2026-11-01', instructions: [ins('/r/CLAUDE.md', true), ins('/r/.claude/rules/a.md', false)] },
      { at: '2026-11-03', instructions: [ins('/r/CLAUDE.md', true)] },
    ]);
    expect(t).toEqual([
      { path: '/r/.claude/rules/a.md', kind: 'Project', sessions: 1, atStartSessions: 0, firstAt: '2026-11-01', lastAt: '2026-11-01' },
      { path: '/r/CLAUDE.md', kind: 'Project', sessions: 2, atStartSessions: 2, firstAt: '2026-11-01', lastAt: '2026-11-03' },
    ]);
  });

  it('stores paths and counts, never text', () => {
    const db = openStore(tmp('rules-store-'));
    const cols = (db.prepare('PRAGMA table_info(rule_file)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain('text');
    expect(cols).not.toContain('content');
    putRuleFiles(db, 'p', '/r', [{ path: '/r/CLAUDE.md', kind: 'Project', sessions: 2, atStartSessions: 2, firstAt: 'a', lastAt: 'b' }]);
    putRuleFiles(db, 'p', '/r', [{ path: '/r/AGENTS.md', kind: 'Project', sessions: 1, atStartSessions: 1, firstAt: 'a', lastAt: 'b' }]);
    // Replaced per project, not accumulated.
    expect(readRuleFiles(db, 'p')).toEqual({ cwd: '/r', files: [{ path: '/r/AGENTS.md', kind: 'Project', sessions: 1, atStartSessions: 1, firstAt: 'a', lastAt: 'b' }] });
    db.close();
  });
});

describe('memory that does not load by itself', () => {
  it('finds this folder memory as on demand, and a parent folder memory as never loaded here', () => {
    const { claude, cwd, home } = world();
    const m = nearbyMemory(cwd, claude);
    expect(m.map((x) => [x.scope, x.name, x.type, x.listed])).toEqual([
      ['on-demand', 'mine', 'feedback', true],
      ['on-demand', 'notes', 'project', false],
      ['parent', 'never-push', 'feedback', true],
      ['parent', 'ref', 'reference', false],
    ]);
    expect(notLoadedRules(m).map((x) => x.name)).toEqual(['never-push']);
    expect(m.find((x) => x.name === 'never-push')?.folder).toBe(join(home, 'work'));
  });

  it('reads frontmatter at the top level or under metadata', () => {
    expect(frontmatter('---\nname: a\ntype: feedback\n---\nx')).toEqual({ name: 'a', type: 'feedback' });
    expect(frontmatter('no frontmatter')).toEqual({});
  });

  it('writes nothing under the Claude folder', () => {
    const { claude, cwd } = world();
    const list = (): string[] => readdirSync(claude, { recursive: true }).map(String).sort();
    const before = list();
    const mtime = statSync(memoryDir(cwd, claude)).mtimeMs;
    nearbyMemory(cwd, claude);
    rulesCounts(cwd, claude, []);
    expect(list()).toEqual(before);
    expect(statSync(memoryDir(cwd, claude)).mtimeMs).toBe(mtime);
  });

  it('expands a home path the parser shortened', () => {
    expect(untilde('~/work/app', '/h')).toBe('/h/work/app');
    expect(untilde('/abs', '/h')).toBe('/abs');
  });
});

describe('facts about the files', () => {
  it('finds the same line in two files, and a link to a file that does not exist', () => {
    const checks = structuralChecks(
      [
        { path: '/r/CLAUDE.md', text: '# Rules\n- Comments are short and factual, always.\n- See [hooks](docs/hooks.md).\n' },
        { path: '/r/.claude/rules/c.md', text: '* **Comments are short and factual, always.**\n```\nComments are short and factual, always.\n```\n' },
      ],
      (p) => p !== '/r/docs/hooks.md',
    );
    expect(checks).toEqual([
      { kind: 'duplicate', line: 'comments are short and factual, always.', files: ['/r/.claude/rules/c.md', '/r/CLAUDE.md'] },
      { kind: 'missing-link', file: '/r/CLAUDE.md', target: 'docs/hooks.md' },
    ]);
  });

  it('stays quiet on clean files: headings, short lines, web links and existing files', () => {
    const checks = structuralChecks(
      [
        { path: '/r/A.md', text: '# Same heading here\n- ok\n- [site](https://example.com)\n' },
        { path: '/r/B.md', text: '# Same heading here\n- ok\n- [there](./A.md)\n' },
      ],
      () => true,
    );
    expect(checks).toEqual([]);
  });
});

describe('the pane data and the session-start line', () => {
  it('reads each file live, redacted, and lists nearby memory', () => {
    const { claude, cwd } = world();
    const archive = tmp('rules-archive-');
    writeFileSync(join(cwd, 'CLAUDE.md'), '- Never push.\n- token ghp_AbCdEf1234567890AbCdEf1234567890\n');
    const db = openStore(archive);
    putRuleFiles(db, projectKey(cwd), cwd, [{ path: join(cwd, 'CLAUDE.md'), kind: 'Project', sessions: 3, atStartSessions: 3, firstAt: 'a', lastAt: 'b' }]);
    db.close();
    const r = rulesFor(archive, cwd, claude);
    expect(r?.loaded.map((f) => f.display)).toEqual(['CLAUDE.md']);
    expect(r?.loaded[0]?.lines?.join('\n')).toContain('Never push.');
    expect(JSON.stringify(r)).not.toContain('ghp_AbCdEf1234567890');
    expect(r?.memory.filter((m) => m.scope === 'parent').map((m) => m.name)).toEqual(['never-push', 'ref']);
  });

  it('says how many rules do not load, only when there are any', () => {
    expect(rulesLine({ notLoaded: 0 })).toBe('');
    expect(rulesLine(undefined)).toBe('');
    expect(rulesLine({ notLoaded: 1 })).toBe('1 rule you wrote does not load in this project. For more info open the "Rules" tab in /vibesenpai:insights');
    const s = { v: 1, computedAt: '', sessions: 3, edits: 9, tokens: { output: 0, cacheCreation: 0 }, dimensions: [], reasons: {}, wastedTokens: {}, unreadable: 0 } as Standing;
    // Kept even when there is nothing else to flag.
    expect(reportBlock(s, undefined, [], 0, [], 0, { notLoaded: 2, checks: 0 })).toContain('nothing to flag across 9 edits.\n  2 rules you wrote do not load');
    expect(reportBlock(s, undefined, [], 0, [], 0, { notLoaded: 0, checks: 0 })).not.toContain('rules you wrote');
  });
});
