/**
 * `src/cost.ts`: the arithmetic behind every token figure. Guards against pricing the wrong side
 * of a pair (the retry, or the first call), which would silently double every number.
 */

import { describe, expect, it } from 'vitest';
import { approx, carriedTurnsAfter, costFor } from '../src/cost.ts';
import type { Event } from '../src/types.ts';

let seq = 0;
function ev(partial: Partial<Event> & Pick<Event, 'turnType'>): Event {
  seq += 1;
  return {
    uuid: `u${seq}`,
    sessionId: 's1',
    seq,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    ...partial,
  } as Event;
}

/** A refused edit, its error, and the retry that succeeded. */
function refusedThenRetried(): Event[] {
  seq = 0;
  return [
    ev({ turnType: 'user_prompt' }),
    ev({
      turnType: 'tool_use',
      toolName: 'Edit',
      toolCallId: 'c1',
      filePath: '/a.ts',
      argHash: 'h1',
      argBytes: 4000,
    }),
    ev({
      turnType: 'tool_result',
      toolCallId: 'c1',
      isError: true,
      failureKind: 'tool',
      outBytes: 200,
      textSummary: 'File has not been read yet. Read it first before writing to it.',
    }),
    ev({ turnType: 'assistant_msg' }),
    ev({
      turnType: 'tool_use',
      toolName: 'Edit',
      toolCallId: 'c2',
      filePath: '/a.ts',
      argHash: 'h2',
      // Deliberately enormous: if the retry is ever priced, the test fails loudly.
      argBytes: 999_999,
    }),
    ev({ turnType: 'tool_result', toolCallId: 'c2', isError: false, outBytes: 10 }),
    ev({ turnType: 'assistant_msg' }),
  ];
}

describe('costFor · edit_retry', () => {
  it('prices the failed attempt, never the retry', () => {
    const c = costFor(refusedThenRetried(), { dimension: 'edit_retry' });
    // 4000 bytes / 4 = 1000. The retry's 999,999 must not appear.
    expect(c.written).toBe(1000);
    expect(c.received).toBe(50);
  });

  it('narrows to one subject', () => {
    const events = refusedThenRetried();
    expect(costFor(events, { dimension: 'edit_retry', subject: '/a.ts' }).written).toBe(1000);
    expect(costFor(events, { dimension: 'edit_retry', subject: '/other.ts' }).written).toBe(0);
  });

  it('narrows to one reason, which is the grain `fix` recommends at', () => {
    const events = refusedThenRetried();
    const reasonOf = (): string => 'not-read-first';
    expect(costFor(events, { dimension: 'edit_retry', reason: 'not-read-first' }, reasonOf).written).toBe(1000);
    expect(costFor(events, { dimension: 'edit_retry', reason: 'string-not-found' }, reasonOf).written).toBe(0);
  });

  it('is zero, not a guess, when the parser stored no sizes', () => {
    const events = refusedThenRetried().map((e) => {
      const { argBytes: _drop, ...rest } = e as Event & { argBytes?: number };
      return { ...rest, ...(e.outBytes !== undefined ? { outBytes: 0 } : {}) } as Event;
    });
    const c = costFor(events, { dimension: 'edit_retry' });
    expect(c.written).toBe(0);
    expect(c.received).toBe(0);
  });

  it('returns zero for a dimension it cannot price', () => {
    expect(costFor(refusedThenRetried(), { dimension: 'file_churn' }).written).toBe(0);
  });
});

/** Three identical calls with identical output and nothing in between. */
function repeatedCalls(): Event[] {
  seq = 0;
  const out: Event[] = [ev({ turnType: 'user_prompt' })];
  for (const [i, id] of ['r1', 'r2', 'r3'].entries()) {
    out.push(
      ev({
        turnType: 'tool_use',
        toolName: 'Read',
        toolCallId: id,
        filePath: '/big.ts',
        argHash: 'same',
        argBytes: 40,
      }),
      ev({ turnType: 'tool_result', toolCallId: id, isError: false, outHash: 'same', outBytes: 4000 }),
      ev({ turnType: 'assistant_msg', responseId: `m${i}` }),
    );
  }
  return out;
}

describe('costFor · redundant_call', () => {
  it('prices the repeats, never the first call that did the work', () => {
    const c = costFor(repeatedCalls(), { dimension: 'redundant_call' });
    // Two repeats: args 40/4 = 10 each, results 4000/4 = 1000 each.
    expect(c.written).toBe(20);
    expect(c.received).toBe(2000);
  });

  it('honours the subject, so one finding does not print the session total', () => {
    const events = repeatedCalls();
    expect(costFor(events, { dimension: 'redundant_call', subject: 'Read /big.ts' }).received).toBe(2000);
    expect(costFor(events, { dimension: 'redundant_call', subject: 'Read /other.ts' }).received).toBe(0);
  });

  it('is mostly received, which is why written and received are separate', () => {
    const c = costFor(repeatedCalls(), { dimension: 'redundant_call' });
    // A repeated read is mostly bytes the agent did not write.
    expect(c.received).toBeGreaterThan(c.written * 50);
  });
});

describe('carriedTurnsAfter', () => {
  it('stops at a compaction, which summarises the text away', () => {
    seq = 0;
    const events = [
      ev({ turnType: 'tool_result', toolCallId: 'c1', outBytes: 100 }),
      ev({ turnType: 'assistant_msg', responseId: 'm1' }),
      ev({ turnType: 'assistant_msg', responseId: 'm2' }),
      ev({ turnType: 'system', systemKind: 'compaction' }),
      ev({ turnType: 'assistant_msg', responseId: 'm3' }),
      ev({ turnType: 'assistant_msg', responseId: 'm4' }),
    ];
    expect(carriedTurnsAfter(events, events[0] as Event)).toBe(2);
  });

  it('counts requests, not records — one response spans several', () => {
    seq = 0;
    const events = [
      ev({ turnType: 'tool_result', toolCallId: 'c1', outBytes: 100 }),
      // One API response written as three records, all sharing a response id.
      ev({ turnType: 'assistant_msg', responseId: 'm1' }),
      ev({ turnType: 'tool_use', responseId: 'm1' }),
      ev({ turnType: 'tool_use', responseId: 'm1' }),
      // A pure tool-call response: no assistant_msg at all, but still a request.
      ev({ turnType: 'tool_use', responseId: 'm2' }),
    ];
    // Context is re-sent once per request: two, not four.
    expect(carriedTurnsAfter(events, events[0] as Event)).toBe(2);
  });

  it('counts only the same thread — a subagent has its own context', () => {
    seq = 0;
    const events = [
      ev({ turnType: 'tool_result', toolCallId: 'c1', outBytes: 100 }),
      ev({ turnType: 'assistant_msg', responseId: 'm1' }),
      ev({ turnType: 'assistant_msg', responseId: 's1', sidechainId: 'sub1' }),
      ev({ turnType: 'assistant_msg', responseId: 's2', sidechainId: 'sub1' }),
      ev({ turnType: 'assistant_msg', responseId: 'm2' }),
    ];
    expect(carriedTurnsAfter(events, events[0] as Event)).toBe(2);
  });

  it('runs to the end when nothing bounds it', () => {
    seq = 0;
    const events = [
      ev({ turnType: 'tool_result', toolCallId: 'c1', outBytes: 100 }),
      ev({ turnType: 'assistant_msg', responseId: 'm1' }),
      ev({ turnType: 'assistant_msg', responseId: 'm2' }),
    ];
    expect(carriedTurnsAfter(events, events[0] as Event)).toBe(2);
  });

  it('reports 0 rather than a record count when response ids are absent', () => {
    seq = 0;
    const events = [
      ev({ turnType: 'tool_result', toolCallId: 'c1', outBytes: 100 }),
      ev({ turnType: 'assistant_msg' }),
      ev({ turnType: 'assistant_msg' }),
    ];
    // Without response ids the request count is unknown; 0 makes `render.ts` omit the line.
    expect(carriedTurnsAfter(events, events[0] as Event)).toBe(0);
  });
});

describe('approx', () => {
  it('rounds DOWN and marks the figure as a floor', () => {
    // `ceil(len/4)` undercounts real tokens, so figures are lower bounds.
    expect(approx(12_345)).toBe('12,000+');
    expect(approx(5678)).toBe('5,600+');
    expect(approx(42)).toBe('42+');
  });

  it('says nothing rather than "0+" when nothing was measured', () => {
    expect(approx(0)).toBe('0');
  });
});

describe('costFor honours `reason` on EVERY dimension, not just edit_retry', () => {
  it('prices only the repeats whose result carries the asked-for reason', () => {
    // Regression: `redundant_call` ignored `reason` and priced the whole dimension.
    const events = repeatedCalls();
    expect(costFor(events, { dimension: 'redundant_call' }).received).toBe(2000);
    // A reason nothing carries must price at zero, not at the total.
    expect(
      costFor(events, { dimension: 'redundant_call', reason: 'string-not-found' }, () => undefined).received,
    ).toBe(0);
    // And a reason everything carries must price the same as no filter at all.
    expect(
      costFor(events, { dimension: 'redundant_call', reason: 'stale-read' }, () => 'stale-read' as never).received,
    ).toBe(2000);
  });
});
