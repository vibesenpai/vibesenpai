/**
 * The session-start report.
 *
 * This prints at the top of every session through `systemMessage`, which
 * reaches the user and not the model. It is the most-seen output the tool has,
 * so these tests are mostly about restraint: what it refuses to say, and how
 * short it stays.
 */

import { describe, expect, it } from 'vitest';
import { costLine, dimensionLine, MAX_DIMENSIONS, reasonLabel, reasonLines, reportBlock } from '../src/report-line.ts';
import type { Standing } from '../src/standing.ts';

const base = (over: Partial<Standing> = {}): Standing => ({
  v: 1,
  computedAt: '2026-10-19T12:00:00.000Z',
  sessions: 4,
  edits: 174,
  tokens: { output: 4_200_000, cacheCreation: 31_400_000 },
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

describe('report — the real standing from this machine', () => {
  it('produces the agreed block', () => {
    const out = reportBlock(base(), '/agentsensei for the exact turns');
    expect(out).toContain('agentsensei report · your last 4 sessions');
    expect(out).toContain('4 edits were rejected and retried, across 3 files');
    expect(out).toContain('most often rosy-seeking-feather.md');
    expect(out).toContain("the text didn't match");
    expect(out).toContain("the file wasn't read first");
    expect(out).toContain('/agentsensei for the exact turns');
  });

  it('starts on its own line, so it does not run on from the harness prefix', () => {
    // The harness renders `SessionStart:startup says:` immediately before this,
    // and without the newline the first line read "says: agentsensei · …".
    expect(reportBlock(base()).startsWith('\n')).toBe(true);
  });

  it('answers "4 what edits?" by naming the worst file', () => {
    // The first reader's actual question. One name is enough to recognise;
    // the rest stays a count so the block height does not grow with the files.
    expect(reportBlock(base())).toContain('rosy-seeking-feather.md');
  });

  it('keeps every line narrow enough not to wrap', () => {
    // Measured against a real terminal: ~70 columns available. An earlier
    // version ran to 87 and wrapped mid-sentence.
    const lines = reportBlock(base(), '/agentsensei for the exact turns').split('\n');
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(70);
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
    expect(out).toContain('174 edits'); // the denominator is what makes it a result
    expect(out.trim().split('\n')).toHaveLength(1);
  });

  it('stays silent about a normal cost even with no findings', () => {
    // Below the corpus p90 the line said "you are normal" every session. The
    // person who built the metric could not read it; now its presence is the
    // signal.
    const out = reportBlock(base({ dimensions: [], reasons: {} }));
    expect(out).not.toMatch(/re-ingest|context/i);
    expect(out).toContain('nothing to flag');
  });

  it('speaks up when the cost is genuinely unusual', () => {
    const hot = base({ dimensions: [], reasons: {}, tokens: { output: 1000, cacheCreation: 200_000 } });
    const out = reportBlock(hot);
    expect(out).toContain('rebuilt its context far more often than usual');
    expect(out).not.toMatch(/\d+(\.\d+)?×/); // no ratio to decode
  });

  it('caps the dimensions and counts the rest', () => {
    const many = base({
      dimensions: [
        { dimension: 'edit_retry', occurrences: 9, sessions: 3, files: 2, top: { subject: '/a/x.ts', occurrences: 7 } },
        { dimension: 'redundant_call', occurrences: 4, sessions: 2, files: 1, top: { subject: '/a/y.ts', occurrences: 4 } },
        { dimension: 'something_else', occurrences: 1, sessions: 1, files: 1 },
      ],
    });
    const out = reportBlock(many);
    expect(out).toContain('9 edits were rejected and retried');
    expect(out).toContain('4 calls were repeated with the same answer');
    expect(out).not.toContain('something_else');
    expect(out).toContain('…1 more');
    expect(MAX_DIMENSIONS).toBe(2);
  });

  it('names sessions it could not read instead of hiding them', () => {
    expect(reportBlock(base({ unreadable: 2 }))).toContain('2 sessions could not be read');
  });

  it('says an outlier is unusual without calling it bad', () => {
    const out = costLine(base({ tokens: { output: 1000, cacheCreation: 200_000 } }));
    expect(out).toContain('far more often than usual');
    expect(out).not.toMatch(/high|excessive|too much|bad|wrong/i);
  });

  it('is silent below the threshold and with no token data', () => {
    expect(costLine(base())).toBe(''); // 7.5x, below p90
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

  it('orders reasons by weight, one per line', () => {
    expect(reasonLines({ a: 1, b: 5 })).toEqual(['     5  b', '     1  a']);
  });

  it('pluralises the dimension line correctly', () => {
    expect(dimensionLine({ dimension: 'edit_retry', occurrences: 1, sessions: 1, files: 0 })).toContain('1 edit was rejected');
    expect(dimensionLine({ dimension: 'edit_retry', occurrences: 2, sessions: 1, files: 0 })).toContain('2 edits were rejected');
  });
});
