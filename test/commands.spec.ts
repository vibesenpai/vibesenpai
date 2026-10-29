/** A developer's slash command reaches the judge with its instructions; a skill the agent loaded does not pass for one. */

import { describe, expect, it } from 'vitest';
import { parseTranscript, slashCommand, withFullText } from '../src/parsers/claude-code.ts';
import { buildSession, COMMAND_BODY_MAX } from '../src/judge/packet.ts';
import { renderExtract } from '../src/judge/prompt.ts';
import { wouldLeak } from '../src/judge/model.ts';

const at = (i: number) => `2026-10-27T10:00:${String(i).padStart(2, '0')}.000Z`;
const rec = (i: number, parent: string | null, o: Record<string, unknown>) =>
  JSON.stringify({ sessionId: 's1', version: '2.1.296', timestamp: at(i), uuid: `u${i}`, parentUuid: parent, ...o });

const ECHO = '<command-message>security:review</command-message>\n<command-name>/security:review</command-name>\n<command-args>of pr 12</command-args>';
const BODY = '<objective>Review only. Do not modify code. Write the report to .planning/security/REVIEW.md</objective>';

function packet(lines: string[]): string {
  const r = withFullText(() => parseTranscript(lines, 's1'));
  return renderExtract([buildSession('s1', [...r.result.events].sort((a, b) => a.seq - b.seq), r.fullText)]);
}

const command = [
  rec(1, null, { type: 'user', message: { role: 'user', content: ECHO } }),
  rec(2, 'u1', { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: BODY }] } }),
  rec(3, 'u2', { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'All fixes applied and tests pass.' }] } }),
];

describe('developer slash commands in the packet', () => {
  it('reads the name and arguments from the echo', () => {
    expect(slashCommand(ECHO)).toBe('/security:review of pr 12');
    expect(slashCommand('<local-command-stdout>x</local-command-stdout>')).toBeUndefined();
  });

  it('shows the command as a developer turn, with its instructions, and in the request list', () => {
    const p = packet(command);
    expect(p).toMatch(/turn \d+: \/security:review of pr 12/);
    expect(p).toContain('[instructions of /security:review] <objective>Review only. Do not modify code.');
    expect(p).toContain('All fixes applied');
  });

  it('carries a repeated command\'s instructions once', () => {
    const again = [
      ...command,
      rec(4, 'u3', { type: 'user', message: { role: 'user', content: ECHO } }),
      rec(5, 'u4', { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: BODY }] } }),
    ];
    const p = packet(again);
    expect(p.split('Do not modify code').length - 1).toBe(1);
    expect(p).toContain('[instructions of /security:review, as above]');
  });

  it('caps the instructions', () => {
    const long = `<objective>${'Follow every step. '.repeat(400)}</objective>`;
    const p = packet([command[0]!, rec(2, 'u1', { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: long }] } })]);
    const body = /\[instructions of \/security:review\] (.*)/.exec(p)?.[1] ?? '';
    expect(body.length).toBeLessThanOrEqual(COMMAND_BODY_MAX);
    expect(body.length).toBeGreaterThan(COMMAND_BODY_MAX / 2);
  });

  it('does not show a skill the agent loaded as something the developer asked', () => {
    const skill = [
      rec(1, null, { type: 'user', message: { role: 'user', content: 'tidy the docs' } }),
      rec(2, 'u1', { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'docs' } }] } }),
      rec(3, 'u2', { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Launching skill: docs' }] } }),
      rec(4, 'u3', { type: 'user', isMeta: true, sourceToolUseID: 't1', message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /x. Never write prose longer than a line.' }] } }),
    ];
    const p = packet(skill);
    expect(p).not.toContain('Never write prose');
    expect(p).not.toContain('[instructions of /docs]');
  });

  it('keeps a built-in command\'s output out', () => {
    const p = packet([
      rec(1, null, { type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>' } }),
      rec(2, 'u1', { type: 'user', message: { role: 'user', content: '<local-command-stdout>Set model to opus</local-command-stdout>' } }),
    ]);
    expect(p).toContain('/model opus');
    expect(p).not.toContain('Set model to');
  });

  it('reads only the neutral field, so any harness\'s parser can feed it', () => {
    const ev = (seq: number, o: Record<string, unknown>) =>
      ({ sessionId: 's1', harness: 'codex', uuid: `c${seq}`, parentUuid: null, seq, isSidechain: false, ...o }) as never;
    const full = new Map([[0, '/review pr 7'], [1, 'Only read; never edit files.'], [2, 'Edited three files.']]);
    const s = buildSession('s1', [
      ev(0, { turnType: 'user_prompt', devCommand: { name: '/review', part: 'invocation' } }),
      ev(1, { turnType: 'user_prompt', devCommand: { name: '/review', part: 'instructions' } }),
      ev(2, { turnType: 'assistant_msg' }),
    ], full);
    const p = renderExtract([s]);
    expect(p).toMatch(/turn \d+: \/review pr 7/);
    expect(p).toContain('[instructions of /review] Only read; never edit files.');
  });

  it('never sends a secret written into a command body', () => {
    const p = packet([command[0]!, rec(2, 'u1', { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Deploy with API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 then review.' }] } })]);
    expect(p).toContain('[instructions of /security:review]');
    expect(wouldLeak(p)).toBe(false);
  });
});
