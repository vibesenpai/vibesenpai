/**
 * `src/judge.ts` — and above all, what it refuses.
 *
 * A judge is a detector whose author cannot be code-reviewed, so the gate is on
 * the way out. These tests exist because the very first real judge response
 * invented its evidence: Haiku reported a `constraint_violation` citing turn 4
 * of a session whose packet starts at turn 400, and turn 4 is a
 * `file-history-snapshot` that could not support any claim about a developer.
 * The anchor check dropped it, which is the only reason that run produced
 * nothing instead of something plausible and false.
 */

import { describe, expect, it } from 'vitest';
import {
  buildSession, CARRY_MAX_OPEN_FAILURES, JUDGE_DIMENSIONS, openFailuresBefore, parseResponse,
  PREAMBLE_PROMPT_MAX, renderPacket, type JudgePacketSession,
} from '../src/judge.ts';

const packet = (over: Partial<JudgePacketSession> = {}): JudgePacketSession => ({
  sessionId: 's1',
  prompts: ['do the thing, but do not add dependencies'],
  windows: ['U  do the thing\nA  on it\n→  Bash pnpm add left-pad'],
  turns: [10, 11, 12],
  ...over,
});

const reply = (findings: unknown[]): string => JSON.stringify({ findings });

describe('parseResponse — what it refuses', () => {
  it('drops a finding citing a turn the packet never contained', () => {
    // The exact shape of the first real hallucination.
    const r = parseResponse(
      reply([{ sessionId: 's1', dimension: 'constraint_violation', turns: [4], why: 'plausible prose' }]),
      [packet()],
    );
    expect(r.findings).toHaveLength(0);
    expect(r.dropped[0]?.reason).toContain('turn the packet does not contain');
  });

  it('drops a finding with no turns at all', () => {
    const r = parseResponse(
      reply([{ sessionId: 's1', dimension: 'overreach', turns: [], why: 'felt wrong' }]),
      [packet()],
    );
    expect(r.findings).toHaveLength(0);
  });

  it('drops a dimension outside the rubric', () => {
    // The model cannot widen its own remit.
    const r = parseResponse(
      reply([{ sessionId: 's1', dimension: 'code_smell', turns: [10], why: 'x' }]),
      [packet()],
    );
    expect(r.findings).toHaveLength(0);
    expect(r.dropped[0]?.reason).toContain('rubric');
  });

  it('drops a session that was not in the batch', () => {
    const r = parseResponse(
      reply([{ sessionId: 'never-sent', dimension: 'overreach', turns: [10], why: 'x' }]),
      [packet()],
    );
    expect(r.findings).toHaveLength(0);
  });

  it('drops a finding with no reason', () => {
    const r = parseResponse(
      reply([{ sessionId: 's1', dimension: 'overreach', turns: [10], why: '  ' }]),
      [packet()],
    );
    expect(r.findings).toHaveLength(0);
  });

  it('survives prose instead of JSON without throwing', () => {
    const r = parseResponse('I had a look and everything seems fine!', [packet()]);
    expect(r.findings).toHaveLength(0);
    expect(r.dropped[0]?.reason).toContain('not JSON');
  });

  it('accepts a fenced block, the common near-miss', () => {
    const r = parseResponse(
      '```json\n' + reply([{ sessionId: 's1', dimension: 'overreach', turns: [10], why: 'ok' }]) + '\n```',
      [packet()],
    );
    expect(r.findings).toHaveLength(1);
  });

  it('keeps a well-formed finding, so the gate is not just "refuse everything"', () => {
    const r = parseResponse(
      reply([{ sessionId: 's1', dimension: 'constraint_violation', turns: [10, 12], why: 'said no deps' }]),
      [packet()],
    );
    expect(r.findings).toEqual([
      { sessionId: 's1', dimension: 'constraint_violation', turns: [10, 12], why: 'said no deps' },
    ]);
  });
});

describe('openFailuresBefore', () => {
  const ev = (seq: number, o: Record<string, unknown>) => ({ uuid: `u${seq}`, sessionId: 's1', seq, ...o });

  it('keeps a failure nothing later resolved', () => {
    const events = [
      ev(1, { turnType: 'tool_result', toolName: 'Bash', filePath: '/a.ts', isError: true }),
      ev(2, { turnType: 'assistant_msg' }),
    ];
    expect(openFailuresBefore(events as never, 100)).toHaveLength(1);
  });

  it('forgets a failure a later success resolved', () => {
    // Deliberately over-forgiving: a stale entry invites the judge to hunt for
    // a claim contradicting a failure that was already fixed, and inviting a
    // false finding is worse than missing one.
    const events = [
      ev(1, { turnType: 'tool_result', toolName: 'Bash', filePath: '/a.ts', isError: true }),
      ev(2, { turnType: 'tool_result', toolName: 'Bash', filePath: '/a.ts', isError: false }),
    ];
    expect(openFailuresBefore(events as never, 100)).toHaveLength(0);
  });

  it('ignores turns at or after the boundary', () => {
    const events = [ev(50, { turnType: 'tool_result', toolName: 'Bash', filePath: '/a.ts', isError: true })];
    expect(openFailuresBefore(events as never, 50)).toHaveLength(0);
  });

  it('is capped, so a long session cannot grow an unbounded carry', () => {
    const events = Array.from({ length: 40 }, (_, i) =>
      ev(i + 1, { turnType: 'tool_result', toolName: 'Bash', filePath: `/f${i}.ts`, isError: true }),
    );
    expect(openFailuresBefore(events as never, 1000).length).toBeLessThanOrEqual(CARRY_MAX_OPEN_FAILURES);
  });
});

describe('the carry between batches', () => {
  const withCarry = (): JudgePacketSession => ({
    ...packet(),
    carry: {
      openFailures: [{ turn: 412, what: 'Bash pnpm test' }],
      reported: [{ dimension: 'overreach', turns: [9] }],
      turnsJudged: 420,
    },
  });

  it('lets a finding reach back to a carried failure', () => {
    // How S7 survives batching: the claim is in this batch, the failure it
    // contradicts was three batches ago. Measured: 12% of evidence spans a
    // batch boundary at the default cadence.
    const r = parseResponse(
      reply([{ sessionId: 's1', dimension: 'inaccurate_self_report', turns: [10, 412], why: 'said tests pass' }]),
      [withCarry()],
    );
    expect(r.findings).toHaveLength(1);
  });

  it('refuses a finding resting ONLY on carried turns', () => {
    // Nothing from the window means the judge is reporting what it was told
    // rather than what it read — a finding invented out of a summary.
    const r = parseResponse(
      reply([{ sessionId: 's1', dimension: 'inaccurate_self_report', turns: [412], why: 'x' }]),
      [withCarry()],
    );
    expect(r.findings).toHaveLength(0);
    expect(r.dropped[0]?.reason).toContain('only carried turns');
  });

  it('still refuses a turn that is in neither', () => {
    const r = parseResponse(
      reply([{ sessionId: 's1', dimension: 'overreach', turns: [10, 9999], why: 'x' }]),
      [withCarry()],
    );
    expect(r.findings).toHaveLength(0);
  });

  it('tells the judge what is already reported, and what was left failing', () => {
    const text = renderPacket([withCarry()]);
    expect(text).toContain('420 turns already reviewed');
    expect(text).toContain('turn 412');
    expect(text).toContain('do not report again');
  });

  it('says so plainly when nothing was left failing', () => {
    const clean = { ...packet(), carry: { openFailures: [], reported: [], turnsJudged: 50 } };
    expect(renderPacket([clean])).toContain('nothing was left failing');
  });
});

describe('the packet', () => {
  it('includes only windows containing a user prompt', () => {
    const sk = (seq: number, k: 'user' | 'tool') => ({
      v: 1, tool: 'claude-code', schema: 'skeleton',
      lines: [k === 'user'
        ? { k: 'user', text: 'hello', ref: { uuid: `u${seq}`, sessionId: 's1', seq } }
        : { k: 'tool', tool: 'Bash', ref: { uuid: `u${seq}`, sessionId: 's1', seq } }],
    });
    const s = buildSession('s1', [], [sk(1, 'user'), sk(2, 'tool')] as never);
    // 39% of windows carry a prompt, and that filter is the whole cost saving.
    expect(s.windows).toHaveLength(1);
    expect(s.turns).toEqual([1]);
  });

  it('carries every prompt as a preamble, capped', () => {
    const events = [
      { uuid: 'a', sessionId: 's1', seq: 1, turnType: 'user_prompt', textSummary: 'x'.repeat(900) },
      { uuid: 'b', sessionId: 's1', seq: 2, turnType: 'user_prompt', textSummary: 'no new deps' },
    ];
    const s = buildSession('s1', events as never, []);
    // The cross-window constraint memory: a rule stated early must be visible
    // when judging late. ~288 tokens at p50 buys the largest dimension.
    expect(s.prompts).toHaveLength(2);
    expect(s.prompts[0]).toHaveLength(PREAMBLE_PROMPT_MAX);
    expect(s.prompts[1]).toBe('no new deps');
  });

  it('tells the model to cite turns and to prefer saying nothing', () => {
    const text = renderPacket([packet()]);
    expect(text).toMatch(/MUST cite turn numbers/);
    expect(text).toMatch(/empty list is the correct answer/i);
    for (const d of JUDGE_DIMENSIONS) expect(text).toContain(d);
  });
});
