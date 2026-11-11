/** A Claude Code too old for the pane gets one statement of what to update, not a text listing. */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIN_CLAUDE_CODE, olderThan, updateMessage } from '../src/harness/claude-code.ts';

describe('olderThan', () => {
  it('compares releases numerically, not as text', () => {
    expect(olderThan('2.1.298', '2.1.299')).toBe(true);
    expect(olderThan('2.0.999', '2.1.299')).toBe(true);
    expect(olderThan('2.1.299', '2.1.299')).toBe(false);
    expect(olderThan('2.1.300', '2.1.299')).toBe(false);
    expect(olderThan('2.1.1000', '2.1.299')).toBe(false);
    expect(olderThan('3.0.0', '2.1.299')).toBe(false);
  });

  it('reads a development build by its release', () => {
    expect(olderThan('2.1.290-dev.20260920.t101500.sha1a2b3c4', '2.1.299')).toBe(true);
    expect(olderThan('2.1.322-dev', '2.1.299')).toBe(false);
  });

  it('never calls an unknown version old', () => {
    expect(olderThan(undefined)).toBe(false);
    expect(olderThan('')).toBe(false);
    expect(olderThan('nightly')).toBe(false);
  });

  it('says the minimum, the running version and the update command', () => {
    const m = updateMessage('2.1.290');
    expect(m).toContain(`Claude Code ${MIN_CLAUDE_CODE} or later`);
    expect(m).toContain('This session runs 2.1.290');
    expect(m).toContain('claude update');
    expect(m).toContain('/vibesenpai:report');
  });
});

describe('insights in a session on an old Claude Code', () => {
  const run = (version: string): string => {
    const root = mkdtempSync(join(tmpdir(), 'vs-minver-'));
    const projects = join(root, 'projects');
    mkdirSync(join(projects, '-p'), { recursive: true });
    const id = 'aaaaaaaa-0000-0000-0000-000000000001';
    const line = (i: number, o: Record<string, unknown>) =>
      JSON.stringify({ sessionId: id, version, timestamp: `2026-11-10T10:00:0${i}.000Z`, uuid: `u${i}`, parentUuid: i === 1 ? null : `u${i - 1}`, cwd: '/p', ...o });
    writeFileSync(join(projects, '-p', `${id}.jsonl`), [
      line(1, { type: 'user', message: { role: 'user', content: 'hello' } }),
      line(2, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }),
    ].join('\n') + '\n');
    return execFileSync(process.execPath, ['--experimental-strip-types', 'src/cli.ts', 'insights', '--session', id], {
      env: { ...process.env, VIBESENPAI_SOURCES: projects, VIBESENPAI_ARCHIVE: join(root, 'store'), VIBESENPAI_CONFIG: join(root, 'none.json'), NO_COLOR: '1', NODE_NO_WARNINGS: '1' },
      encoding: 'utf8',
    });
  };

  it('states the update instead of the findings', () => {
    const out = run('2.1.290');
    expect(out).toContain(`needs Claude Code ${MIN_CLAUDE_CODE} or later. This session runs 2.1.290.`);
    expect(out).not.toContain('Your history');
  });

  it('shows the text version as before on a current Claude Code, where only room kept the pane closed', () => {
    const out = run('2.1.322');
    expect(out).not.toContain('needs Claude Code');
  });
});
