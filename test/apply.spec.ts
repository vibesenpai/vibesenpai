/** Applying a fix: the request the agent is handed, and the marker that dates it in the transcript. */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { applyRequest, destination, guardHook, POINTER, RULES_FILE, snippetFor } from '../src/harness/claude-code.ts';
import { fixIdsIn } from '../src/fix-marker.ts';
import { parseTranscript } from '../src/parsers/claude-code.ts';
import { countDenominators } from '../src/detect/index.ts';
import type { ApplyPlan } from '../src/fix.ts';

const rule: ApplyPlan = { fixId: 'a1b2c3', dimension: 'overreach', target: 'project-instructions', text: '- Do only what was asked.' };
const other: ApplyPlan = { fixId: '0f9e8d', dimension: 'edit_retry', target: 'project-instructions', text: '- Re-read before editing.' };
const session: ApplyPlan = { fixId: '777777', dimension: 'misread_intent', target: 'session', text: 'For the rest of this session: state your reading.' };

describe('the request the agent is handed', () => {
  it('puts a rule in our own file, and only a pointer in CLAUDE.md', () => {
    const r = applyRequest([rule]);
    expect(r).toContain(`Add this line to ${RULES_FILE}`);
    expect(r).toContain('\n- Do only what was asked.\n');
    expect(r).toContain(`if CLAUDE.md does not already point to that file, add this line to it:\n${POINTER}`);
  });

  it('drafts several fixes as one request with one marker', () => {
    const r = applyRequest([rule, other, session]);
    expect(r).toContain('these lines');
    expect(r).toContain('For the rest of this session: state your reading.');
    expect(r.match(/\(vibesenpai fix/g)).toHaveLength(1);
    expect(fixIdsIn(r)).toEqual(['a1b2c3', '0f9e8d', '777777']);
  });

  it('asks nothing of CLAUDE.md for a session-only fix', () => {
    expect(applyRequest([session])).not.toContain('CLAUDE.md');
  });
});

describe('a finding\'s own fix, per target', () => {
  const plan = (o: Partial<ApplyPlan> & Pick<ApplyPlan, 'target' | 'text'>): ApplyPlan => ({ fixId: 'abc123', dimension: 'constraint_violation', ...o });

  it('a permission rule goes in project-local settings, in the dialog\'s own form', () => {
    const p = plan({ target: 'project-permissions', text: 'git push' });
    expect(destination(p)).toBe('.claude/settings.local.json');
    expect(applyRequest([p])).toContain('add "Bash(git push *)" to permissions.ask');
    expect(JSON.parse(snippetFor(p) as string)).toEqual({ permissions: { ask: ['Bash(git push *)'] } });
  });

  it('a scoped rule is its own file, with the paths it loads for', () => {
    const p = plan({ target: 'scoped-instructions', text: '- Standing instruction from the developer: "x"', paths: ['hooks/pane.tsx'] });
    expect(destination(p)).toBe('.claude/rules/vibesenpai/abc123.md');
    expect(snippetFor(p)).toBe('---\npaths:\n  - "hooks/pane.tsx"\n---\n\n- Standing instruction from the developer: "x"');
    expect(applyRequest([p])).not.toContain('CLAUDE.md');
  });

  it('a broken instruction asks for a check, shown before it is added', () => {
    const r = applyRequest([plan({ target: 'project-check', text: 'Never write the user\'s config.', from: 'CLAUDE.md' })]);
    expect(r).toContain('CLAUDE.md already says "Never write the user\'s config.", and it was broken anyway.');
    expect(r).toContain('before adding it');
  });

  it('the read-only subagent restricts its tools', () => {
    const p = plan({ target: 'project-agent', text: 'ask' });
    expect(destination(p)).toBe('.claude/agents/ask.md');
    expect(snippetFor(p)).toContain('tools: Read, Grep, Glob');
  });

  it('every request still ends with its marker', () => {
    for (const target of ['project-permissions', 'project-hooks', 'scoped-instructions', 'project-check', 'project-agent'] as const) {
      expect(fixIdsIn(applyRequest([plan({ target, text: 'git push' })]))).toEqual(['abc123']);
    }
  });
});

describe('the guard hook, run as Claude Code runs it', () => {
  const command = (path: string): string =>
    ((guardHook(path) as { hooks: { PreToolUse: { hooks: { command: string }[] }[] } }).hooks.PreToolUse[0]?.hooks[0]?.command) as string;
  const run = (path: string, input: object): number => {
    try {
      execFileSync('sh', ['-c', command(path)], { input: JSON.stringify(input), env: { ...process.env, HOME: '/home/me' }, stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 });
      return 0;
    } catch (e) {
      return (e as { status: number }).status;
    }
  };

  it('blocks an edit of exactly that path with exit 2', () => {
    expect(run('~/.claude.json', { tool_name: 'Edit', tool_input: { file_path: '/home/me/.claude.json' } })).toBe(2);
  });

  it('lets every other path through, including one that merely starts the same', () => {
    expect(run('~/.claude.json', { tool_name: 'Edit', tool_input: { file_path: '/home/me/repo/a.ts' } })).toBe(0);
    expect(run('~/.claude.json', { tool_name: 'Edit', tool_input: { file_path: '/home/me/.claude.json.bak' } })).toBe(0);
  });

  it('exits 0 on empty or unreadable input: a broken guard must not block', () => {
    expect(run('~/.claude.json', {})).toBe(0);
  });
});

const at = (i: number) => `2026-10-28T10:00:${String(i).padStart(2, '0')}.000Z`;
const rec = (i: number, o: Record<string, unknown>) =>
  JSON.stringify({ sessionId: 's1', version: '2.1.296', timestamp: at(i), uuid: `u${i}`, parentUuid: i === 1 ? null : `u${i - 1}`, ...o });

describe('the marker in a transcript', () => {
  const lines = [
    rec(1, { type: 'user', message: { role: 'user', content: 'fix the parser' } }),
    rec(2, { type: 'user', message: { role: 'user', content: applyRequest([rule]) } }),
    rec(3, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Done ${applyRequest([other])}` }] } }),
  ];
  const events = parseTranscript(lines, 's1').events;

  it('dates the fix on the developer prompt that carries it', () => {
    expect(events.filter((e) => e.fixApplied !== undefined).map((e) => [e.turnType, e.fixApplied])).toEqual([['user_prompt', ['a1b2c3']]]);
  });

  it('is not a turn of the developer\'s own work', () => {
    expect(countDenominators([...events]).turnCount).toBe(1);
  });
});

describe('applying through a command the developer typed', () => {
  it('dates the fix from the command\'s output, and only for a command the developer ran', () => {
    const echo = '<command-message>vibesenpai:apply</command-message>\n<command-name>/vibesenpai:apply</command-name>';
    const body = `Apply this fix:\n\n${applyRequest([rule])}`;
    const lines = [
      rec(1, { type: 'user', message: { role: 'user', content: echo } }),
      rec(2, { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: body }] } }),
      // The same text loaded by the agent as a skill hangs off a tool result, not the echo.
      JSON.stringify({ sessionId: 's1', timestamp: at(3), uuid: 'x3', parentUuid: 'tool-result', type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: applyRequest([other]) }] } }),
    ];
    const marked = parseTranscript(lines, 's1').events.filter((e) => e.fixApplied !== undefined);
    expect(marked.map((e) => e.fixApplied)).toEqual([['a1b2c3']]);
  });
});
