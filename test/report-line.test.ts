/**
 * The session-start report.
 *
 * This prints at the top of every session through `systemMessage`, which
 * reaches the user and not the model. It is the most-seen output the tool has,
 * so these tests are mostly about restraint: what it refuses to say, and how
 * short it stays.
 */

import { describe, expect, it } from 'vitest';
import { costLine, dimensionLine, MAX_DIMENSIONS, reasonLabel, reasonsLine, reportBlock } from '../src/report-line.ts';
import type { Standing } from '../src/standing.ts';

const base = (over: Partial<Standing> = {}): Standing => ({
  v: 1,
  computedAt: '2026-10-19T12:00:00.000Z',
  sessions: 4,
  edits: 174,
  tokens: { output: 4_200_000, cacheCreation: 31_400_000 },
  dimensions: [{ dimension: 'edit_retry', occurrences: 3, sessions: 1 }],
  reasons: { 'not-read-first': 2, 'string-not-found': 1 },
  unreadable: 0,
  ...over,
});

describe('report — the real standing from this machine', () => {
  it('produces the agreed block', () => {
    const out = reportBlock(base());
    expect(out).toContain('agentsensei · 4 sessions · 174 edits');
    expect(out).toContain('3 edits refused then retried');
    expect(out).toContain('2 not read first');
    expect(out).toContain('context re-ingested 7.5× output (median 12.0)');
    expect(out).toContain('`agentsensei now`');
  });

  it('stays short enough to read every single session', () => {
    // It opens every session. Anything longer belongs in `now`.
    expect(reportBlock(base()).split('\n').length).toBeLessThanOrEqual(6);
  });
});

describe('report — what it refuses to say', () => {
  it('uses no imperative verb and no severity word', () => {
    // Same rule the ambient nudge had: a tool that nags about something it is
    // occasionally wrong about gets uninstalled. Advice lives in `now`.
    const out = reportBlock(base()).toLowerCase();
    for (const nag of ['fix', 'should', 'must', 'avoid', 'warning', 'error', 'bad', '!']) {
      expect(out, `must not contain "${nag}"`).not.toContain(nag);
    }
  });

  it('prints no score, total or grade', () => {
    const out = reportBlock(base()).toLowerCase();
    for (const banned of ['score', 'grade', '/100', 'out of']) {
      expect(out).not.toContain(banned);
    }
  });

  it('never mentions cacheRead, however tempting a ratio looks', () => {
    // It re-counts the whole prefix per call, so any ratio on it is pinned near
    // 1 by construction — p10 0.901 to p90 0.985 across the corpus.
    const out = reportBlock(base());
    expect(out).not.toMatch(/hit rate|cache read|cacheRead/i);
  });

  it('never mentions file churn', () => {
    // Measured at 15% correlation against a 9% base rate, and half the
    // top-churn paths are files whose purpose is to be rewritten. Orientation
    // does not earn the one place everybody sees.
    expect(reportBlock(base())).not.toMatch(/rewritten|churn|version/i);
  });
});

describe('report — the empty and edge cases', () => {
  it('says nothing at all before the first pass has run', () => {
    // The install just happened and the detached pass is still going. Silence
    // is right: it will have something next time.
    expect(reportBlock(undefined)).toBe('');
  });

  it('says "nothing to flag" rather than going silent on a clean history', () => {
    // Silence here would read as broken, and inventing a finding is worse.
    const out = reportBlock(base({ dimensions: [], reasons: {}, tokens: { output: 0, cacheCreation: 0 } }));
    expect(out).toContain('nothing to flag');
    expect(out.split('\n')).toHaveLength(1);
  });

  it('still reports the cost when there are no findings', () => {
    const out = reportBlock(base({ dimensions: [], reasons: {} }));
    expect(out).toContain('context re-ingested');
    expect(out).not.toContain('nothing to flag');
  });

  it('caps the dimensions and counts the rest', () => {
    const many = base({
      dimensions: [
        { dimension: 'edit_retry', occurrences: 9, sessions: 3 },
        { dimension: 'redundant_call', occurrences: 4, sessions: 2 },
        { dimension: 'something_else', occurrences: 1, sessions: 1 },
      ],
    });
    const out = reportBlock(many);
    expect(out).toContain('9 edits refused then retried');
    expect(out).toContain('4 identical calls repeated');
    expect(out).not.toContain('something_else');
    expect(out).toContain('…1 more');
    expect(MAX_DIMENSIONS).toBe(2);
  });

  it('names sessions it could not read instead of hiding them', () => {
    expect(reportBlock(base({ unreadable: 2 }))).toContain('2 sessions could not be read');
  });

  it('says where an outlier sits without calling it bad', () => {
    const hot = base({ tokens: { output: 1000, cacheCreation: 200_000 } });
    const out = costLine(hot);
    expect(out).toContain('corpus p90');
    expect(out).not.toMatch(/high|excessive|too much/i);
  });

  it('omits the cost line when there is no token data', () => {
    expect(costLine(base({ tokens: { output: 0, cacheCreation: 0 } }))).toBe('');
  });
});

describe('report — reason keys become English', () => {
  it('translates every key the label tier can produce', () => {
    // The key is an identifier, not language. A reader should not have to
    // decode `not-read-first` at the top of every session.
    for (const key of ['not-read-first', 'string-not-found', 'stale-read', 'ambiguous-target']) {
      expect(reasonLabel(key)).not.toContain('-');
    }
  });

  it('degrades an unknown key rather than dropping it', () => {
    // A harness rewording produces an unrecognised reason; it must still read
    // as something, because the finding behind it still stands.
    expect(reasonLabel('some-new-thing')).toBe('some new thing');
  });

  it('orders reasons by weight', () => {
    expect(reasonsLine({ a: 1, b: 5 })).toBe('5 b · 1 a');
  });

  it('pluralises the dimension line correctly', () => {
    expect(dimensionLine({ dimension: 'edit_retry', occurrences: 1, sessions: 1 })).toContain('1 edit refused');
    expect(dimensionLine({ dimension: 'edit_retry', occurrences: 2, sessions: 1 })).toContain('2 edits refused');
  });
});
