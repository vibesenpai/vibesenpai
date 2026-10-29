/** The judge's packet builder and leak gate, and above all what they refuse. */

import { describe, expect, it } from 'vitest';
import { redact } from '../src/redact.ts';
import { wouldLeak } from '../src/judge/model.ts';
import {
  buildPacket, renderSession, buildSession, CARRY_MAX_OPEN_FAILURES, estimateTokens, largestFittingWindow, openFailuresBefore, partOfTurn, PREAMBLE_PROMPT_MAX, type JudgePacketSession,
} from '../src/judge/packet.ts';
import { renderExtract } from '../src/judge/prompt.ts';

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
        // A quote from the call must resolve to 12, not to the block start.
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
    // Deliberately over-forgiving: a stale entry would invite a false finding.
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
    // Every turn is shown; merging and tiering replaced filtering to prompt windows.
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
    // A rule stated early must be visible when judging late.
    expect(s.prompts).toHaveLength(2);
    expect(s.prompts[0]?.text).toHaveLength(PREAMBLE_PROMPT_MAX);
    expect(s.prompts[1]?.text).toBe('no new deps');
    // Labelled by turn, so the packet has one numbering scheme.
    expect(s.prompts.map((p) => p.turn)).toEqual([1, 2]);
    expect(s.turns).toContain(1);
  });

  it('labels prompts by turn, never by position', () => {
    // Bracket indices in the preamble made models cite `[3]` as turn 3.
    const text = renderExtract([packet()]);
    expect(text).toContain('turn 9:');
    expect(text).not.toMatch(/^\s*\[\d+\]/m);
  });

  it('leaves harness task-notifications out of the preamble', () => {
    // Harness notifications are not the developer's words.
    const events = [
      { uuid: 'a', sessionId: 's1', seq: 1, turnType: 'user_prompt', textSummary: '<task-notification> id 123' },
      { uuid: 'b', sessionId: 's1', seq: 2, turnType: 'user_prompt', textSummary: 'real request' },
    ];
    const s = buildSession('s1', events as never, new Map());
    expect(s.prompts.map((p) => p.text)).toEqual(['real request']);
  });

  it('does not call a session oversized because its first event makes no turn', () => {
    // Regression: a first event that makes no turn must not mark the session unreadable.
    const events = [
      { uuid: 'a', sessionId: 's1', seq: 1, turnType: 'user_prompt', textSummary: '' },
      { uuid: 'b', sessionId: 's1', seq: 2, turnType: 'user_prompt', textSummary: 'do the thing' },
      { uuid: 'c', sessionId: 's1', seq: 3, turnType: 'tool_use', toolName: 'Bash', command: 'pnpm test' },
    ];
    expect(buildSession('s1', events.slice(0, 1) as never, new Map()).packet.turns).toHaveLength(0);
    const win = largestFittingWindow('s1', events as never, new Map(), undefined, 60_000);
    expect(win?.turns).toBe(3);
    expect(win?.session.packet.turns.length).toBeGreaterThan(0);
  });

  it('still returns nothing when no window holding a turn fits', () => {
    const events = [
      { uuid: 'a', sessionId: 's1', seq: 1, turnType: 'user_prompt', textSummary: '' },
      { uuid: 'b', sessionId: 's1', seq: 2, turnType: 'user_prompt', textSummary: 'do the thing' },
    ];
    // A budget that holds the empty frame and nothing more.
    const frame = estimateTokens(renderExtract([buildSession('s1', events.slice(0, 1) as never, new Map())]));
    expect(largestFittingWindow('s1', events as never, new Map(), undefined, frame)).toBeUndefined();
  });

  it('reads a turn too large for any packet in parts, losing nothing', () => {
    // Only a developer's message can exceed the budget (agent turns are capped).
    const words = Array.from({ length: 4000 }, (_, i) => `word${i}`);
    // Markers scattered through, so some cut lands near one.
    for (let i = 50; i < words.length; i += 97) words[i] = '[REDACTED:api-key]';
    const long = words.join(' ');
    const events = [
      { uuid: 'a', sessionId: 's1', seq: 0, turnType: 'user_prompt', textSummary: '' },
      { uuid: 'b', sessionId: 's1', seq: 1, turnType: 'user_prompt', textSummary: long },
      { uuid: 'c', sessionId: 's1', seq: 2, turnType: 'assistant_msg', textSummary: 'done' },
    ];
    const full = new Map([[1, long]]);
    const budget = 6000;
    expect(largestFittingWindow('s1', events as never, full, undefined, budget)).toBeUndefined();

    const sent: string[] = [];
    let resume: { seq: number; chars: number } | undefined;
    for (let pass = 0; pass < 100; pass += 1) {
      const part = partOfTurn('s1', events as never, full, undefined, budget, resume);
      expect(part).toBeDefined();
      if (part === undefined) break;
      expect(part.seq).toBe(1);
      expect(part.turns, 'the window ends at the long turn').toBe(2);
      expect(estimateTokens(renderExtract([part.session]))).toBeLessThanOrEqual(budget);
      const body = part.session.packet.turns.find((t) => t.seqs.includes(1))?.text ?? '';
      expect(body).toMatch(/^\[one message sent in parts: characters \d+-\d+ of \d+\]\n/);
      const chunk = body.replace(/^[^\n]*\n/, '');
      // A cut never splits a redaction marker.
      expect(chunk).not.toMatch(/\[[^\]]*$/);
      expect(chunk).not.toMatch(/^[^\[]*\]/);
      sent.push(chunk);
      if (part.end === part.length) break;
      resume = { seq: part.seq, chars: part.end };
    }
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.join(''), 'every character, once, in order').toBe(long);
  });

  it('never cuts a redacted secret into a part the leak gate refuses', () => {
    // A refusal here would repeat every pass and trip the breaker. Text is pre-redacted, as the
    // parser does, with assignment shapes dense enough that cuts land beside them.
    const shapes = [
      'API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
      'export TOKEN: ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',
      'password = hunter2-correct-horse-battery',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlc2ln',
    ];
    const raw = Array.from({ length: 1200 }, (_, i) => (i % 7 === 0 ? shapes[i % shapes.length] : `w${i}`)).join(' ');
    const text = redact(raw).text;
    expect(text).toContain('[REDACTED:');
    const events = [{ uuid: 'b', sessionId: 's1', seq: 1, turnType: 'user_prompt', textSummary: text }];
    const full = new Map([[1, text]]);

    for (const budget of [2500, 2777, 3100, 3500, 4200]) {
      const sent: string[] = [];
      let resume: { seq: number; chars: number } | undefined;
      for (let pass = 0; pass < 200; pass += 1) {
        const part = partOfTurn('s1', events as never, full, undefined, budget, resume);
        if (part === undefined) throw new Error(`no part at budget ${budget}`);
        expect(wouldLeak(renderExtract([part.session])), `budget ${budget}, part ${pass}`).toBe(false);
        sent.push((part.session.packet.turns[0]?.text ?? '').replace(/^[^\n]*\n/, ''));
        if (part.end === part.length) break;
        resume = { seq: part.seq, chars: part.end };
      }
      expect(sent.length).toBeGreaterThan(1);
      expect(sent.join('')).toBe(text);
    }
  });

  it('starts the turn again when the cursor names a different one', () => {
    const long = 'x '.repeat(30_000);
    const events = [{ uuid: 'b', sessionId: 's1', seq: 1, turnType: 'user_prompt', textSummary: long }];
    const part = partOfTurn('s1', events as never, new Map([[1, long]]), undefined, 6000, { seq: 99, chars: 500 });
    expect(part?.session.packet.turns[0]?.text).toMatch(/^\[one message sent in parts: characters 1-/);
  });

  // Prompt wording is pinned in test/two-stage.spec.ts; this tests the shared `buildSession`.
});

describe('the redaction gate refuses rather than redacts', () => {
  it('a packet containing a secret is not clean, so the send must abort', () => {
    // The predicate must notice unredacted text, not quietly fix it.
    const dirty = 'turn 1 | AGENT\n[Bash] export TOKEN=sk-ant-api03-REDACTEDLOOKALIKE123456';
    expect(redact(dirty).text).not.toBe(dirty);
  });

  it('a packet built by the builder is already clean', () => {
    // The builder redacts last, so the gate never fires on its output.
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
    // Regression: the preamble once filtered `<command-name>` while the turn body kept it.
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
