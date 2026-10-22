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
  buildSession, CARRY_MAX_OPEN_FAILURES, openFailuresBefore,
  PREAMBLE_PROMPT_MAX, renderExtract, type JudgePacketSession,
} from '../src/judge.ts';

/** A packet whose turns really contain the text a finding must quote. */
const packet = (over: Partial<JudgePacketSession> = {}): JudgePacketSession => ({
  sessionId: 's1',
  prompts: [{ turn: 9, text: 'do the thing, but do not add dependencies' }],
  packet: {
    sessionId: 's1',
    turns: [
      {
        role: 'USER', seqs: [9], text: 'do the thing, but do not add dependencies',
        parts: [{ seq: 9, text: 'do the thing, but do not add dependencies' }],
      },
      {
        role: 'AGENT', seqs: [10, 11, 12], text: 'on it\n\n[Bash] pnpm add left-pad',
        // Two constituents: the prose at 10, the call at 12. A quote from the
        // call must resolve to 12, not to the block start.
        parts: [{ seq: 10, text: 'on it' }, { seq: 12, text: '[Bash] pnpm add left-pad' }],
      },
    ],
    seqs: [9, 10, 11, 12],
  },
  turns: [9, 10, 11, 12],
  ...over,
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
    const text = renderExtract([packet()]);
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

  // The prompt's own wording is asserted in test/two-stage.test.ts, where the
  // stage-A assertion is the right way round: it must NOT offer a dimension.
  // This block tests `buildSession`, which both stages share.
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

describe('the preamble and the turns agree on what the developer said', () => {
  it('keeps a slash command in the preamble, not just in the turns', () => {
    // There were two `isHarnessNoise` functions with one name and different
    // behaviour: `packet.ts` deliberately kept `<command-name>` while
    // `judge.ts` still filtered it. So a slash command survived into the turn
    // body and was stripped from the preamble that claims to list "what the
    // developer asked for, in order" — the one place it most needed to be. One
    // gold episode's entire evidence is a `<command-name>` record.
    const events = [
      { uuid: 'a', sessionId: 's1', seq: 1, turnType: 'user_prompt' },
      { uuid: 'b', sessionId: 's1', seq: 2, turnType: 'assistant_msg' },
    ];
    const full = new Map<number, string>([
      [1, '<command-name>/gsd:discuss-phase</command-name> <command-args>23</command-args>'],
      [2, 'Let me look at the API client extraction.'],
    ]);
    const s = buildSession('s1', events as never, full);

    expect(s.prompts.map((p) => p.text).join('\n')).toContain('/gsd:discuss-phase');
    expect(renderExtract([s])).toContain('/gsd:discuss-phase');
  });

  it('still keeps a harness task notification out of both', () => {
    const events = [{ uuid: 'a', sessionId: 's1', seq: 1, turnType: 'user_prompt' }];
    const full = new Map<number, string>([[1, '<task-notification>done</task-notification>']]);
    const s = buildSession('s1', events as never, full);
    expect(s.prompts).toEqual([]);
  });
});
