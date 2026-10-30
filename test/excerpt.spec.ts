/** The conversation around a finding: windowed by message, tool calls folded in, redacted. */

import { describe, expect, it } from 'vitest';
import { excerptOf } from '../src/excerpt.ts';
import { redact } from '../src/redact.ts';
import type { Event } from '../src/types.ts';

const ev = (seq: number, turnType: Event['turnType'], o: Partial<Event> = {}): Event =>
  ({ sessionId: 's', harness: 'claude-code', uuid: `u${seq}`, parentUuid: null, seq, isSidechain: false, turnType, ts: `2026-10-29T10:${String(seq).padStart(2, '0')}:00.000Z`, ...o }) as Event;

// prompt, reply with two tool calls (one failed), prompt, reply, prompt, reply
const events = [
  ev(1, 'user_prompt', { textSummary: 'rename the command' }),
  ev(2, 'assistant_msg', { textSummary: 'Renaming it.' }),
  ev(3, 'tool_use', { toolName: 'Edit', filePath: 'commands/fix.md' }),
  ev(4, 'tool_result', { textSummary: 'ok' }),
  ev(5, 'tool_use', { toolName: 'Bash', command: 'npm test\nand more' }),
  ev(6, 'tool_result', { textSummary: 'boom', isError: true }),
  ev(7, 'user_prompt', { textSummary: 'I want it to be /agentsensei:fix' }),
  ev(8, 'assistant_msg', { textSummary: 'Done.' }),
  ev(9, 'user_prompt', { textSummary: 'thanks' }),
  ev(10, 'assistant_msg', { textSummary: 'Welcome.' }),
];

describe('an excerpt', () => {
  it('takes messages either side of the cited turn, with tool calls as one line each', () => {
    const x = excerptOf(events, new Map(), [7], 1);
    if (!x.kept) throw new Error('kept');
    expect(x.parts[0]!.map((m) => [m.role, m.cited])).toEqual([['agent', false], ['developer', true], ['agent', false]]);
    expect(x.parts[0]![0]!.tools).toEqual(['Edit commands/fix.md', 'Bash npm test · failed']);
    expect(x.parts[0]![1]!.at).toBe('2026-10-29T10:07:00.000Z');
    expect([x.moreBefore, x.moreAfter]).toEqual([true, true]);
  });

  it('places a cited tool result in the message it belongs to, and joins windows that touch', () => {
    const x = excerptOf(events, new Map(), [6, 9], 1);
    if (!x.kept) throw new Error('kept');
    expect(x.parts).toHaveLength(1);
    expect(x.parts[0]!.filter((m) => m.cited).map((m) => m.text)).toEqual(['Renaming it.', 'thanks']);
  });

  it('reads the full text where the parser kept it, and redacts what it returns', () => {
    const token = 'ghp_AbCdEf1234567890AbCdEf1234567890';
    const x = excerptOf(events, new Map([[7, `I want it to be /agentsensei:fix, and here is ${token}`]]), [7], 0);
    if (!x.kept) throw new Error('kept');
    const text = x.parts[0]![0]!.text;
    expect(text).toMatch(/here is/);
    expect(text).not.toContain(token);
    expect(redact(JSON.stringify(x)).text).toBe(JSON.stringify(x));
  });
});
