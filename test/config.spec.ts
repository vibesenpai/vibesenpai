import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { resolveConfig } from '../src/config.ts';

const home = '/home/dev';
const sources = (env: NodeJS.ProcessEnv): string[] =>
  resolveConfig({ env: { VIBESENPAI_CONFIG: '/nonexistent/config.json', ...env }, home }).config.sources;

describe('default transcript sources', () => {
  it('reads ~/.claude/projects when CLAUDE_CONFIG_DIR is unset', () => {
    expect(sources({})[0]).toBe(join(home, '.claude', 'projects'));
  });

  it('follows CLAUDE_CONFIG_DIR, where Claude Code then writes its transcripts', () => {
    expect(sources({ CLAUDE_CONFIG_DIR: '/tmp/profile' })[0]).toBe(join('/tmp/profile', 'projects'));
  });

  it('ignores an empty CLAUDE_CONFIG_DIR', () => {
    expect(sources({ CLAUDE_CONFIG_DIR: '  ' })[0]).toBe(join(home, '.claude', 'projects'));
  });

  it('lets VIBESENPAI_SOURCES win over CLAUDE_CONFIG_DIR', () => {
    expect(sources({ CLAUDE_CONFIG_DIR: '/tmp/profile', VIBESENPAI_SOURCES: '/x' })).toEqual(['/x']);
  });
});
