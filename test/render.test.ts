/**
 * The renderer is the product surface, so these tests are mostly about what it
 * must NOT print.
 *
 * CLAUDE.md allows two outputs — evidence, and something applicable — and bans
 * the score. A test suite that only checked formatting would let a total creep
 * in, which is the one regression that would change what this tool is.
 */

import { describe, expect, it } from 'vitest';
import { durationOf, render, renderCost, renderFinding, shortenPath, spanOf, describeTurn, CORPUS } from '../src/render.ts';
import { materialise } from '../src/finding.ts';
import type { Denominators } from '../src/detect/index.ts';
import type { Event, Finding } from '../src/types.ts';

const zeros: Denominators = {
  turnCount: 0,
  editCount: 0,
  toolCallCount: 0,
  failedCallCount: 0,
  unclassifiedTouchCount: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
};

let seq = 0;
const ev = (over: Partial<Event> & Pick<Event, 'turnType'>): Event => {
  seq += 1;
  return {
    sessionId: 's1',
    harness: 'claude-code',
    uuid: over.uuid ?? `u${seq}`,
    parentUuid: null,
    seq: over.seq ?? seq,
    isSidechain: false,
    ...over,
  } as Event;
};

const finding = (over: Partial<Finding> = {}): Finding => ({
  ...materialise({
    candidate: {
      dimension: 'edit_retry',
      subject: '/repo/src/api.ts',
      evidence: [
        { uuid: 'a', sessionId: 's1', seq: 10 },
        { uuid: 'b', sessionId: 's1', seq: 11 },
        { uuid: 'c', sessionId: 's1', seq: 12 },
      ],
      anchors: [{ uuid: 'b', sessionId: 's1', seq: 11 }],
      confidence: 'certain',
      method: 'RULE',
      polarity: 'lower-is-better',
      requiresOutcome: false,
    },
    sessionId: 's1',
    project: 'proj',
    now: '2026-10-19T00:00:00.000Z',
  }),
  ...over,
});

describe('render — what it must never print', () => {
  it('prints no score, total or grade', () => {
    const out = render({
      findings: [finding({ reasons: { 'not-read-first': 3 } })],
      denominators: { ...zeros, editCount: 40, tokens: { input: 1, output: 1000, cacheRead: 9, cacheCreation: 12000 } },
      sessionId: 'abcdef1234',
      events: [],
    });
    // An unexplained number is the thing this project exists as an alternative
    // to, and a total is what people optimise instead of reading evidence.
    for (const banned of ['score', 'grade', '/100', 'out of', 'total:']) {
      expect(out.toLowerCase(), `must not contain "${banned}"`).not.toContain(banned);
    }
  });

  it('never prints cacheRead, however tempting a ratio looks', () => {
    // It re-counts the whole prefix per call, so any ratio on it is pinned near
    // 1 by construction — p10 0.901 to p90 0.985 across the corpus.
    const out = renderCost({
      ...zeros,
      tokens: { input: 10, output: 100, cacheRead: 9_000_000, cacheCreation: 1200 },
    }).join('\n');
    expect(out).not.toContain('9.0M');
    expect(out).not.toMatch(/hit rate/i);
    expect(out).toContain('re-ingested');
  });

  it('uses no imperative verb in the subject line', () => {
    const line = renderFinding(finding())[0] as string;
    for (const nag of ['fix', 'stop', 'avoid', 'should', 'must']) {
      expect(line.toLowerCase()).not.toContain(nag);
    }
  });
});

describe('render — evidence is checkable in place', () => {
  it('says what happened at each cited turn, not just its number', () => {
    const edit = ev({ turnType: 'tool_use', toolName: 'Edit', filePath: '/repo/src/api.ts', uuid: 'a', seq: 10 });
    const refused = ev({
      turnType: 'tool_result', uuid: 'b', seq: 11, isError: true, failureKind: 'tool',
      textSummary: '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>',
    });
    const retry = ev({ turnType: 'tool_use', toolName: 'Edit', filePath: '/repo/src/api.ts', uuid: 'c', seq: 12 });
    const out = render({
      findings: [finding({ reasons: { 'not-read-first': 1 } })],
      denominators: { ...zeros, editCount: 2 },
      sessionId: 'abcdef1234',
      events: [edit, refused, retry],
    });
    expect(out).toContain('turn    10');
    expect(out).toContain('Edit');
    expect(out).toContain('refused');
    expect(out).toContain('not-read-first');
  });

  it('names the harness reason, never a guess, when it is unrecognised', () => {
    const e = ev({
      turnType: 'tool_result', isError: true, failureKind: 'tool',
      textSummary: '<tool_use_error>Something no release has ever said.</tool_use_error>',
    });
    expect(describeTurn(e)).toContain('Something no release');
    expect(describeTurn(e)).toContain('failed');
  });

  it('prints (reason unknown) rather than implying there was none', () => {
    const out = renderFinding(finding()).join('\n');
    expect(out).toContain('(reason unknown)');
  });
});

describe('render — an empty result is not an unanalysed one', () => {
  it('distinguishes "nothing found" from "nothing to analyse"', () => {
    const noEdits = render({ findings: [], denominators: zeros, sessionId: 's', events: [] });
    expect(noEdits).toContain('no edits');

    const clean = render({ findings: [], denominators: { ...zeros, editCount: 155 }, sessionId: 's', events: [] });
    // The denominator is what makes the difference legible.
    expect(clean).toContain('155 edits');
  });

  it('names muted dimensions, so silence is never mysterious', () => {
    const out = render({
      findings: [], denominators: { ...zeros, editCount: 3 }, sessionId: 's', events: [],
      muted: ['edit_retry'],
    });
    expect(out).toContain('muted: edit_retry');
  });

  it('surfaces the unclassified-touch gap instead of hiding it', () => {
    const out = render({
      findings: [], denominators: { ...zeros, editCount: 3, unclassifiedTouchCount: 4 },
      sessionId: 's', events: [],
    });
    expect(out).toContain('could not be classified');
  });
});

describe('render — timestamps and spans', () => {
  it('ignores records with no usable timestamp', () => {
    // Real shape: every file-history-snapshot lacks one. 107 in a single
    // session. The parser omits them; an empty string would sort below every
    // real timestamp and become the session start.
    const span = spanOf([
      ev({ turnType: 'system', systemKind: 'file-history' }),
      ev({ turnType: 'user_prompt', ts: '2026-10-19T10:00:00.000Z' }),
      ev({ turnType: 'user_prompt', ts: '2026-10-19T11:30:00.000Z' }),
    ]);
    expect(span.first).toBe('2026-10-19T10:00:00.000Z');
    expect(durationOf(span.first, span.last)).toBe('1h30m');
  });

  it('reads a resumed session in days, not hours', () => {
    // Measured on a real session: 174h21m is a week nobody reads as one.
    expect(durationOf('2026-10-12T00:00:00.000Z', '2026-10-19T06:00:00.000Z')).toBe('7d6h');
  });

  it('returns undefined rather than 0m when the span is unknowable', () => {
    expect(durationOf(undefined, '2026-10-19T00:00:00.000Z')).toBeUndefined();
    expect(spanOf([ev({ turnType: 'system' })]).first).toBeUndefined();
  });
});

describe('render — the cost line sits against the corpus', () => {
  it('quotes the median when the session is ordinary', () => {
    const out = renderCost({ ...zeros, tokens: { input: 0, output: 1000, cacheRead: 0, cacheCreation: 7000 } }).join('\n');
    expect(out).toContain('ratio 7.0');
    expect(out).toContain(`corpus median ${CORPUS.reingestP50.toFixed(1)}`);
  });

  it('says where an outlier sits without calling it bad', () => {
    const out = renderCost({ ...zeros, tokens: { input: 0, output: 1000, cacheRead: 0, cacheCreation: 200_000 } }).join('\n');
    expect(out).toContain('90th percentile');
    expect(out).not.toMatch(/bad|too high|excessive|warning/i);
  });

  it('prints nothing at all when there is no token data', () => {
    expect(renderCost(zeros)).toEqual([]);
  });
});

describe('shortenPath keeps the identifying end', () => {
  it('keeps the tail, which is what names the file', () => {
    const long = '/Users/x/very/deeply/nested/project/packages/web/src/components/Thing.tsx';
    const out = shortenPath(long, 30);
    expect(out.endsWith('Thing.tsx')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(30);
  });

  it('leaves a short path alone', () => {
    expect(shortenPath('src/a.ts')).toBe('src/a.ts');
  });
});
