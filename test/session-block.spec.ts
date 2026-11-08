/** The session-start `systemMessage` block: the most-seen output, so mostly tests of restraint. */

import { describe, expect, it } from 'vitest';
import { cacheLine, dimensionLine, MAX_DIMENSIONS, reasonLines, reportBlock } from '../src/session-block.ts';
import type { Standing } from '../src/standing.ts';
import { reasonLabel } from '../src/detect/labels.ts';

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
    const out = reportBlock(base(), '/vibesenpai for the exact turns');
    expect(out).toContain('vibesenpai · your last 4 sessions');
    expect(out).toContain('4 edits were rejected and retried, across 3 files');
    expect(out).toContain('most often rosy-seeking-feather.md');
    expect(out).toContain("the text didn't match");
    expect(out).toContain("the file wasn't read first");
    expect(out).toContain('/vibesenpai for the exact turns');
  });

  it('starts on its own line, so it does not run on from the harness prefix', () => {
    // The harness prints `SessionStart:startup says:` right before this, so start on a new line.
    expect(reportBlock(base()).startsWith('\n')).toBe(true);
  });

  it('answers "4 what edits?" by naming the worst file', () => {
    // One name to recognise; the rest stays a count so the block does not grow.
    expect(reportBlock(base())).toContain('rosy-seeking-feather.md');
  });

  it('keeps every line narrow enough not to wrap', () => {
    // ~70 columns are available in a real terminal.
    const lines = reportBlock(base(), '/vibesenpai for the exact turns').split('\n');
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(70);
  });

  it('stays short enough to read every single session', () => {
    // It opens every session. Anything longer belongs in `now`.
    expect(reportBlock(base()).split('\n').length).toBeLessThanOrEqual(6);
  });
});

describe('report — what it refuses to say', () => {
  it('uses no imperative verb and no severity word', () => {
    // No advice here; advice lives in `now`.
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
    // No cache ratio: it is pinned near 1 by construction (DECISIONS.md D49).
    const out = reportBlock(base());
    expect(out).not.toMatch(/hit rate|cache read|cacheRead/i);
  });

  it('never mentions file churn', () => {
    // File churn is not established as waste (GRAVEYARD.md).
    expect(reportBlock(base())).not.toMatch(/rewritten|churn|version/i);
  });
});

describe('report — the empty and edge cases', () => {
  it('says nothing at all before the first pass has run', () => {
    // The install just happened and the detached pass is still running: silence.
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
    // The cost line appears only when unusual; its presence is the signal.
    const out = reportBlock(base({ dimensions: [], reasons: {} }));
    expect(out).not.toMatch(/re-ingest|context/i);
    expect(out).toContain('nothing to flag');
  });

  it('speaks up when the cache was rebuilt', () => {
    const hot = base({ dimensions: [], reasons: {}, rebuilds: { count: 3, tokens: 2_400_000 } });
    const out = reportBlock(hot);
    expect(out).toContain('The cache was rebuilt from scratch 3 times');
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

  it('speaks only of rebuilds, in plain words and with no mark', () => {
    // No severity on the live surface (CLAUDE.md Principle One), so no `!`.
    const out = cacheLine(base({ rebuilds: { count: 2, tokens: 1_700_000 } }));
    expect(out).toBe('The cache was rebuilt from scratch 2 times — 1.7M tokens written again');
    expect(out).not.toMatch(/!|high|excessive|too much|bad|wrong|should/i);
  });

  it('is silent without rebuilds, however high the cache-write ratio', () => {
    // Not a p90 cut, which flags 10% of anything by construction.
    expect(cacheLine(base({ tokens: { output: 1000, cacheCreation: 200_000 } }))).toBe('');
    expect(cacheLine(base({ rebuilds: { count: 0, tokens: 0 } }))).toBe('');
  });
});

describe('report — reason keys become English', () => {
  it('translates every key the label tier can produce', () => {
    // The reason key is an identifier; show words.
    for (const key of ['not-read-first', 'string-not-found', 'stale-read', 'ambiguous-target']) {
      expect(reasonLabel(key)).not.toContain('-');
    }
  });

  it('degrades an unknown key rather than dropping it', () => {
    // An unrecognised reason still reads as something: the finding stands.
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

describe('the session-start block can see the model tier', () => {
  // Judge findings arrive as a tally from the judge store; `Standing` never holds them.
  const tally = [
    { dimension: 'misread_intent', count: 5 },
    { dimension: 'constraint_violation', count: 5 },
    { dimension: 'other', count: 3 },
  ];

  it('reports the total and names the commonest dimensions', () => {
    const out = reportBlock(base(), undefined, tally);
    expect(out).toContain('13 flagged —');
    expect(out).toContain('misread_intent');
  });

  it('keeps itself to one line, whatever the dimension count', () => {
    // Spelling out every dimension would swamp a short block.
    const out = reportBlock(base(), undefined, tally);
    const judged = out.split('\n').filter((l) => l.includes('flagged —'));
    expect(judged).toHaveLength(1);
    expect(judged[0]).toContain('+1 more');
  });

  it('does not say "nothing to flag" when the judge found something', () => {
    // Regression: a session with only judge findings read as clean.
    const empty = { ...base(), dimensions: [], reasons: {} };
    const out = reportBlock(empty, undefined, tally);
    expect(out).not.toContain('nothing to flag');
    expect(out).toContain('13 flagged —');
  });

  it('still says "nothing to flag" when both tiers are empty', () => {
    const empty = { ...base(), dimensions: [], reasons: {} };
    expect(reportBlock(empty, undefined, [])).toContain('nothing to flag');
  });
});

describe('session start leads with what is new', () => {
  it('names new findings first, and says nothing when there are none', () => {
    expect(reportBlock(base(), undefined, [], 0, [], 2).split('\n')[2]).toBe('  2 new findings since your last session');
    expect(reportBlock(base(), undefined, [], 0, [], 0)).not.toMatch(/new finding/);
  });
});
