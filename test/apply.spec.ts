/** Applying a fix: the request the agent is handed, and the marker that dates it in the transcript. */

import { describe, expect, it } from 'vitest';
import { applyRequest, POINTER, RULES_FILE } from '../src/harness/claude-code.ts';
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
    expect(r.match(/\(agentsensei fix/g)).toHaveLength(1);
    expect(fixIdsIn(r)).toEqual(['a1b2c3', '0f9e8d', '777777']);
  });

  it('asks nothing of CLAUDE.md for a session-only fix', () => {
    expect(applyRequest([session])).not.toContain('CLAUDE.md');
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
    const echo = '<command-message>agentsensei:apply</command-message>\n<command-name>/agentsensei:apply</command-name>';
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
