/**
 * `fix` — the second output.
 *
 * CLAUDE.md allows exactly two: evidence, and something applicable. These tests
 * are mostly about the discipline that keeps the second one honest — one
 * recommendation, always with its evidence, and silence where no artifact
 * exists rather than a manufactured tip.
 */

import { describe, expect, it } from 'vitest';
import { recommend, renderFix } from '../src/fix.ts';
import type { Standing } from '../src/standing.ts';

const base = (over: Partial<Standing> = {}): Standing => ({
  v: 1,
  computedAt: '2026-10-19T12:00:00.000Z',
  sessions: 7,
  edits: 184,
  tokens: { output: 4_600_000, cacheCreation: 32_100_000 },
  dimensions: [
    {
      dimension: 'edit_retry',
      occurrences: 4,
      sessions: 2,
      files: 3,
      top: { subject: '~/.claude/plans/rosy-seeking-feather.md', occurrences: 2 },
    },
  ],
  wastedTokens: {},
  reasons: { 'not-read-first': 2, 'string-not-found': 2 },
  unreadable: 0,
  ...over,
});

describe('fix — exactly one thing', () => {
  it('returns one recommendation, never a list', () => {
    // Behaviour-change research, and the reason `fix` exists rather than a
    // report: a tool that returns six things to fix has returned nothing to do.
    const r = recommend(base());
    expect(r).toBeDefined();
    expect(Array.isArray(r)).toBe(false);
  });

  it('returns nothing when there is nothing measured', () => {
    expect(recommend(undefined)).toBeUndefined();
    expect(recommend(base({ dimensions: [], reasons: {} }))).toBeUndefined();
  });

  it('always carries the evidence that justifies it', () => {
    // A recommendation without its measurement is advice, which is out of scope.
    const r = recommend(base());
    expect(r?.evidence).toContain('4 edits');
    expect(r?.evidence).toContain('7 sessions');
    expect(r?.because).toMatch(/most common reason/);
  });

  it('names the file it happened in most', () => {
    expect(recommend(base())?.evidence).toContain('rosy-seeking-feather.md');
  });
});

describe('fix — choosing what to recommend', () => {
  it('prefers a fixable dimension over a frequent report-only one', () => {
    // `redundant_call` has no artifact; recommending it would mean inventing
    // one. Frequency must not override that.
    const r = recommend(
      base({
        dimensions: [
          { dimension: 'redundant_call', occurrences: 99, sessions: 5, files: 1 },
          { dimension: 'edit_retry', occurrences: 4, sessions: 2, files: 1 },
        ],
      }),
    );
    expect(r?.dimension).toBe('edit_retry');
    expect(r?.kind).toBe('PROMPT');
  });

  it('reports honestly when the only dimension has no artifact', () => {
    const r = recommend(
      base({ dimensions: [{ dimension: 'redundant_call', occurrences: 9, sessions: 2, files: 1 }] }),
    );
    expect(r?.kind).toBe('REPORT');
    expect(r?.prompt).toBeUndefined();
    expect(r?.because).toMatch(/no artifact/i);
  });

  it('reports rather than guesses when the reason is unrecognised', () => {
    // A reworded harness message must not silently map to the nearest
    // familiar fix.
    const r = recommend(base({ reasons: { 'something-new': 5 } }));
    expect(r?.kind).toBe('REPORT');
    expect(r?.prompt).toBeUndefined();
  });

  it('breaks a tie stably, so the recommendation does not flip between runs', () => {
    // 2-2 here. Which one wins is arbitrary; being *stably* arbitrary is what
    // matters, because advice that changes on re-run cannot be followed.
    const a = recommend(base())?.prompt;
    const b = recommend(base())?.prompt;
    expect(a).toBe(b);
  });

  it('picks the artifact from the reason, not the dimension', () => {
    // `not-read-first` and `string-not-found` are both edit_retry and need
    // different changes.
    const readFirst = recommend(base({ reasons: { 'not-read-first': 9 } }))?.prompt;
    const notFound = recommend(base({ reasons: { 'string-not-found': 9 } }))?.prompt;
    expect(readFirst).not.toBe(notFound);
    expect(readFirst).toMatch(/read a file before editing/i);
    expect(notFound).toMatch(/re-read/i);
  });
});

describe('fix — what it renders', () => {
  it('states the measurement before the suggestion', () => {
    const out = renderFix(recommend(base()), 'core');
    expect(out.indexOf('measured')).toBeLessThan(out.indexOf('for this session'));
  });

  it('offers both a session prompt and a CLAUDE.md line', () => {
    const out = renderFix(recommend(base()), 'core');
    expect(out).toContain('for this session');
    expect(out).toContain('CLAUDE.md');
  });

  it('warns that adopting it perturbs the measurement', () => {
    // docs/surfaces.md: a dimension under an active brief reads as suppressed,
    // not improved. Handing one over without saying so would make the next
    // report a lie.
    expect(renderFix(recommend(base()), 'core')).toMatch(/suppressed rather than improved/);
  });

  it('names the preset it chose from', () => {
    // One live detector would otherwise read as "there is only one thing you
    // could improve".
    expect(renderFix(recommend(base()), 'core')).toContain('preset "core"');
    expect(renderFix(recommend(base()), 'standard', ['edit_retry'])).toContain('muted: edit_retry');
  });

  it('says so plainly when there is nothing to recommend', () => {
    expect(renderFix(undefined, 'core')).toContain('nothing to recommend');
  });

  it('keeps every line readable in a terminal', () => {
    const lines = renderFix(recommend(base()), 'core').split('\n');
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(78);
  });

  it('uses no severity word', () => {
    // It is a suggestion built from the user's own data, not a verdict on them.
    const out = renderFix(recommend(base()), 'core').toLowerCase();
    for (const nag of ['warning', 'error', 'bad', 'wrong', 'failure', 'you should']) {
      expect(out, `must not contain "${nag}"`).not.toContain(nag);
    }
  });
});
