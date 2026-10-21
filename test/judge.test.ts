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
import { redact } from '../src/redact.ts';
import { buildPacket, renderSession } from '../src/packet.ts';
import {
  buildSession, CARRY_MAX_OPEN_FAILURES, JUDGE_DIMENSIONS, openFailuresBefore, parseResponse,
  PREAMBLE_PROMPT_MAX, renderPacket, type JudgePacketSession,
} from '../src/judge.ts';

/** A packet whose turns really contain the text a finding must quote. */
const packet = (over: Partial<JudgePacketSession> = {}): JudgePacketSession => ({
  sessionId: 's1',
  prompts: [{ turn: 9, text: 'do the thing, but do not add dependencies' }],
  packet: {
    sessionId: 's1',
    turns: [
      { role: 'USER', seqs: [9], text: 'do the thing, but do not add dependencies' },
      { role: 'AGENT', seqs: [10, 11, 12], text: 'on it\n\n[Bash] pnpm add left-pad' },
    ],
    seqs: [9, 10, 11, 12],
  },
  turns: [9, 10, 11, 12],
  ...over,
});

const reply = (findings: unknown[]): string => JSON.stringify({ findings });

describe('parseResponse — what it refuses', () => {
  it('drops a finding whose quote is not in the packet', () => {
    // The shape of the first real hallucination — now unmissable, because a
    // fabricated quote simply is not found.
    const r = parseResponse(
      reply([{ sessionId: 's1', dimension: 'constraint_violation', quote: 'a sentence nobody ever wrote', why: 'plausible prose' }]),
      [packet()],
    );
    expect(r.findings).toHaveLength(0);
    expect(r.dropped[0]?.reason).toContain('quote is not in the packet');
  });

  it('drops a finding with no quote at all', () => {
    const r = parseResponse(
      reply([{ sessionId: 's1', dimension: 'overreach', why: 'felt wrong' }]),
      [packet()],
    );
    expect(r.findings).toHaveLength(0);
    expect(r.dropped[0]?.reason).toContain('no quote');
  });

  it('drops a dimension outside the rubric', () => {
    // The model cannot widen its own remit.
    const r = parseResponse(
      reply([{ sessionId: 's1', dimension: 'code_smell', quote: 'pnpm add left-pad', why: 'x' }]),
      [packet()],
    );
    expect(r.findings).toHaveLength(0);
    expect(r.dropped[0]?.reason).toContain('rubric');
  });

  it('drops a session that was not in the batch', () => {
    const r = parseResponse(
      reply([{ sessionId: 'never-sent', dimension: 'overreach', quote: 'pnpm add left-pad', why: 'x' }]),
      [packet()],
    );
    expect(r.findings).toHaveLength(0);
  });

  it('drops a finding with no reason', () => {
    const r = parseResponse(
      reply([{ sessionId: 's1', dimension: 'overreach', quote: 'pnpm add left-pad', why: '  ' }]),
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
      '```json\n' +
        reply([{ sessionId: 's1', dimension: 'overreach', quote: 'pnpm add left-pad', why: 'ok' }]) +
        '\n```',
      [packet()],
    );
    expect(r.findings).toHaveLength(1);
  });

  it('refuses a quote too short to identify a turn', () => {
    // A handful of characters could match anywhere. An anchor that ambiguous
    // is not an anchor, so it fails rather than attaching to the first hit.
    const r = parseResponse(
      reply([{ sessionId: 's1', dimension: 'overreach', quote: 'on it', why: 'ok' }]),
      [packet()],
    );
    expect(r.findings).toHaveLength(0);
  });

  it('keeps a well-formed finding and DERIVES the turn from the quote', () => {
    // The model never reports a number. It copies text; we locate it.
    const r = parseResponse(
      reply([
        { sessionId: 's1', dimension: 'constraint_violation', quote: 'pnpm add left-pad', why: 'said no deps' },
      ]),
      [packet()],
    );
    expect(r.findings).toEqual([
      { sessionId: 's1', dimension: 'constraint_violation', turns: [10], quote: 'pnpm add left-pad', why: 'said no deps' },
    ]);
  });

  it('tolerates reflowed whitespace in a quote', () => {
    const r = parseResponse(
      reply([{ sessionId: 's1', dimension: 'overreach', quote: 'pnpm   add\n left-pad', why: 'x' }]),
      [packet()],
    );
    expect(r.findings).toHaveLength(1);
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

  it('informs the judge, while the finding still quotes what was shown', () => {
    // How S7 survives batching: the claim is in this batch, the failure it
    // contradicts was batches ago. Measured: 18.9% of boundaries leave a
    // failure open. The carry supplies that context — but the anchor is still
    // text from the turns, so a finding can never rest on the summary alone.
    const r = parseResponse(
      reply([
        { sessionId: 's1', dimension: 'inaccurate_self_report', quote: 'pnpm add left-pad', why: 'said tests pass' },
      ]),
      [withCarry()],
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.turns).toEqual([10]);
  });

  it('refuses a finding that quotes only the carry', () => {
    // Quoting the summary rather than the transcript is the judge reporting
    // what it was told rather than what it read.
    const r = parseResponse(
      reply([
        { sessionId: 's1', dimension: 'inaccurate_self_report', quote: 'Bash pnpm test failed', why: 'x' },
      ]),
      [withCarry()],
    );
    expect(r.findings).toHaveLength(0);
    expect(r.dropped[0]?.reason).toContain('quote is not in the packet');
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
  it('sends the whole session, not a filtered slice of it', () => {
    // The old packet kept only prompt-bearing windows, which showed the judge
    // **3-7%** of a long session — it was asked what went wrong with work it
    // could not see. Merging and tiering replaced filtering.
    const events = [
      { uuid: 'a', sessionId: 's1', seq: 1, turnType: 'user_prompt', textSummary: 'do the thing' },
      { uuid: 'b', sessionId: 's1', seq: 2, turnType: 'tool_use', toolName: 'Bash', command: 'pnpm test' },
      { uuid: 'c', sessionId: 's1', seq: 3, turnType: 'tool_result', isError: true, textSummary: 'FAIL' },
    ];
    const s = buildSession('s1', events as never, new Map());
    expect(s.turns).toEqual([1, 2, 3]);
    // Consecutive agent turns merge into one; the prompt stays its own.
    expect(s.packet.turns).toHaveLength(2);
    expect(s.packet.turns[1]?.role).toBe('AGENT');
  });

  it('carries every prompt as a preamble, capped', () => {
    const events = [
      { uuid: 'a', sessionId: 's1', seq: 1, turnType: 'user_prompt', textSummary: 'x'.repeat(900) },
      { uuid: 'b', sessionId: 's1', seq: 2, turnType: 'user_prompt', textSummary: 'no new deps' },
    ];
    const s = buildSession('s1', events as never, new Map());
    // The cross-window constraint memory: a rule stated early must be visible
    // when judging late. ~288 tokens at p50 buys the largest dimension.
    expect(s.prompts).toHaveLength(2);
    expect(s.prompts[0]?.text).toHaveLength(PREAMBLE_PROMPT_MAX);
    expect(s.prompts[1]?.text).toBe('no new deps');
    // Labelled by turn, so the packet has ONE numbering scheme. Bracket
    // indices made models cite `[3]` as turn 3.
    expect(s.prompts.map((p) => p.turn)).toEqual([1, 2]);
    expect(s.turns).toContain(1);
  });

  it('labels prompts by turn, never by position', () => {
    // The bug that produced three "hallucinations": the preamble numbered
    // prompts [1] [2] [3] while windows said `turn NNN`, and models cited the
    // bracket numbers. The reasoning was sometimes sound; the citation was
    // answering a question the packet asked badly.
    const text = renderPacket([packet()]);
    expect(text).toContain('turn 9:');
    expect(text).not.toMatch(/^\s*\[\d+\]/m);
  });

  it('leaves harness task-notifications out of the preamble', () => {
    // They arrive as user turns and are long. Quoting the harness back at a
    // judge asking "what did the developer want" invites a finding about a
    // constraint nobody set.
    const events = [
      { uuid: 'a', sessionId: 's1', seq: 1, turnType: 'user_prompt', textSummary: '<task-notification> id 123' },
      { uuid: 'b', sessionId: 's1', seq: 2, turnType: 'user_prompt', textSummary: 'real request' },
    ];
    const s = buildSession('s1', events as never, new Map());
    expect(s.prompts.map((p) => p.text)).toEqual(['real request']);
  });

  it('tells the model to quote verbatim and to prefer saying nothing', () => {
    const text = renderPacket([packet()]);
    expect(text).toMatch(/MUST include a .quote./);
    expect(text).toMatch(/do not write a turn number/);
    expect(text).toMatch(/empty list is the correct answer/i);
    for (const d of JUDGE_DIMENSIONS) expect(text).toContain(d);
  });
});

describe('the redaction gate refuses rather than redacts', () => {
  it('a packet containing a secret is not clean, so the send must abort', () => {
    // The product asserts `redact(packet) === packet` immediately before the
    // call. This test holds the *predicate* to account: it must notice, not
    // quietly fix. Measured: 50% of corpus sessions carry secret-class content
    // at full fidelity, and tool output is where it concentrates.
    const dirty = 'turn 1 | AGENT\n[Bash] export TOKEN=sk-ant-api03-REDACTEDLOOKALIKE123456';
    expect(redact(dirty).text).not.toBe(dirty);
  });

  it('a packet built by the builder is already clean', () => {
    // Belt and braces: the builder redacts as its last construction step, so
    // the gate should never fire on its output. Verified over 200 real
    // sessions during development; this pins the contract.
    const events = [
      { uuid: 'a', sessionId: 's1', seq: 1, turnType: 'user_prompt', textSummary: 'ship it' },
      { uuid: 'b', sessionId: 's1', seq: 2, turnType: 'tool_use', toolName: 'Bash', command: 'echo hi' },
    ];
    const full = new Map([[1, 'ship it'], [2, 'echo hi']]);
    const text = renderSession(buildPacket('s1', events as never, full));
    expect(redact(text).text).toBe(text);
  });
});
