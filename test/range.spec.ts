import { describe, expect, it } from 'vitest';
import {
  parseLast,
  parseDate,
  resolveRange,
  segmentByDepth,
  describeCoverage,
} from '../src/range.ts';

const NOW = new Date('2026-10-18T12:00:00.000Z');
const spanDays = (r: { from: Date; to: Date }): number =>
  Math.max(1, Math.ceil((r.to.getTime() - r.from.getTime()) / 86_400_000));
const d = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

describe('report — relative ranges', () => {
  it('parses days, weeks and months', () => {
    expect(spanDays(parseLast('7d', NOW)!)).toBe(7);
    expect(spanDays(parseLast('4w', NOW)!)).toBe(28);
    expect(spanDays(parseLast('6m', NOW)!)).toBe(180);
  });

  it('rejects nonsense rather than guessing a range', () => {
    for (const bad of ['', '7', 'd7', '7y', '-3d', '0d', 'lots']) {
      expect(parseLast(bad, NOW)).toBeUndefined();
    }
  });
});

describe('report — absolute dates', () => {
  it('parses an ISO date', () => {
    expect(parseDate('2026-09-01')?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('rejects a date that does not exist', () => {
    // `Date.UTC` silently rolls 02-31 into March.
    expect(parseDate('2026-02-31')).toBeUndefined();
    expect(parseDate('2026-13-01')).toBeUndefined();
  });

  it('rejects loose formats', () => {
    for (const bad of ['2026-9-1', '09/01/2026', 'yesterday', '2026']) {
      expect(parseDate(bad)).toBeUndefined();
    }
  });
});

describe('report — flag resolution', () => {
  it('defaults to the last 7 days', () => {
    const r = resolveRange({}, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(spanDays(r.range)).toBe(7);
  });

  it('refuses --last together with --since', () => {
    // Accepting both would need a precedence rule nobody could guess.
    const r = resolveRange({ last: '7d', since: '2026-01-01' }, NOW);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/cannot be combined/);
  });

  it('refuses a reversed range', () => {
    const r = resolveRange({ since: '2026-10-01', until: '2026-09-01' }, NOW);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/after/);
  });

  it('names the offending flag and value in the error', () => {
    const r = resolveRange({ since: 'last tuesday' }, NOW);
    if (!r.ok) expect(r.error).toContain('last tuesday');
  });

  it('treats --since alone as open-ended up to now', () => {
    const r = resolveRange({ since: '2026-10-01' }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.range.to).toEqual(NOW);
  });
});

describe('report — depth labelling is the point', () => {
  // We keep no transcript copies, so coverage past what we hold is stated, never implied as improvement.
  const session = (from: string, to: string) => ({ from: d(from), to: d(to) });
  const oct = [session('2026-10-12', '2026-10-18')];

  it('labels a range inside a covered session as full depth', () => {
    const segs = segmentByDepth({ from: d('2026-10-14'), to: d('2026-10-17') }, {
      covered: oct,
      scanned: true,
      hasPromptHistory: false,
    });
    expect(segs.map((s) => s.depth)).toEqual(['full']);
  });

  it('splits a range that reaches back before any coverage', () => {
    const segs = segmentByDepth({ from: d('2026-09-01'), to: d('2026-10-18') }, {
      covered: oct,
      scanned: true,
      hasPromptHistory: true,
    });
    expect(segs.map((s) => s.depth)).toEqual(['prompt-level', 'full']);
    expect(segs[0]!.to).toEqual(d('2026-10-12'));
    expect(segs[1]!.from).toEqual(d('2026-10-12'));
  });

  it('reports a GAP between sessions rather than claiming it is covered', () => {
    // A single boundary at the earliest record claimed full depth over a month with no sessions.
    const segs = segmentByDepth({ from: d('2026-08-20'), to: d('2026-10-19') }, {
      covered: [session('2026-08-23', '2026-08-24'), session('2026-10-12', '2026-10-19')],
      scanned: true,
      hasPromptHistory: false,
    });
    expect(segs.map((s) => s.depth)).toEqual(['none', 'full', 'none', 'full']);
    const gap = segs[2]!;
    expect(gap.from).toEqual(d('2026-08-24'));
    expect(gap.to).toEqual(d('2026-10-12'));
  });

  it('merges overlapping sessions instead of double-reporting them', () => {
    const segs = segmentByDepth({ from: d('2026-10-10'), to: d('2026-10-20') }, {
      covered: [session('2026-10-12', '2026-10-16'), session('2026-10-15', '2026-10-18')],
      scanned: true,
      hasPromptHistory: false,
    });
    expect(segs.map((s) => s.depth)).toEqual(['none', 'full', 'none']);
    expect(segs[1]!.from).toEqual(d('2026-10-12'));
    expect(segs[1]!.to).toEqual(d('2026-10-18'));
  });

  it('clips coverage to the requested range', () => {
    const segs = segmentByDepth({ from: d('2026-10-14'), to: d('2026-10-16') }, {
      covered: [session('2026-01-01', '2026-12-31')],
      scanned: true,
      hasPromptHistory: false,
    });
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ depth: 'full' });
    expect(segs[0]!.from).toEqual(d('2026-10-14'));
    expect(segs[0]!.to).toEqual(d('2026-10-16'));
  });

  it('reports `none` rather than silence when nothing survives', () => {
    const segs = segmentByDepth({ from: d('2026-01-01'), to: d('2026-02-01') }, {
      covered: oct,
      scanned: true,
      hasPromptHistory: false,
    });
    expect(segs.map((s) => s.depth)).toEqual(['none']);
    expect(describeCoverage(segs)[0]).toMatch(/no transcripts cover this period/);
    // Must NOT blame deletion: before the first scan, a gap and a deletion look the same.
    expect(describeCoverage(segs)[0]).not.toMatch(/deleted/);
  });

  it('treats everything as shallow when nothing has been scanned', () => {
    const segs = segmentByDepth({ from: d('2026-10-01'), to: d('2026-10-18') }, {
      covered: [],
      scanned: false,
      hasPromptHistory: true,
    });
    expect(segs.map((s) => s.depth)).toEqual(['prompt-level']);
  });

  it('says "not scanned" rather than blaming the harness for deleting', () => {
    const segs = segmentByDepth({ from: d('2026-10-01'), to: d('2026-10-18') }, {
      covered: [],
      scanned: false,
      hasPromptHistory: false,
    });
    expect(segs.map((s) => s.depth)).toEqual(['unscanned']);
    expect(describeCoverage(segs)[0]).toMatch(/not scanned yet/);
    expect(describeCoverage(segs)[0]).not.toMatch(/deleted/);
  });

  it('gives full depth for the period the data covers, not the day it was read', () => {
    // The boundary is record timestamps, never `firstSeenAt`.
    const segs = segmentByDepth({ from: d('2026-10-13'), to: d('2026-10-18') }, {
      covered: [session('2026-10-12', '2026-10-18')],
      scanned: true,
      hasPromptHistory: false,
    });
    expect(segs.map((s) => s.depth)).toEqual(['full']);
  });

  it('always returns at least one segment — silence is not an answer', () => {
    const segs = segmentByDepth({ from: d('2026-10-18'), to: d('2026-10-18') }, {
      covered: oct,
      scanned: true,
      hasPromptHistory: false,
    });
    expect(segs).toHaveLength(1);
  });

  it('produces segments that never overlap and tile the range', () => {
    const range = { from: d('2026-08-20'), to: d('2026-10-19') };
    const segs = segmentByDepth(range, {
      covered: [session('2026-08-23', '2026-08-24'), session('2026-10-12', '2026-10-19')],
      scanned: true,
      hasPromptHistory: true,
    });
    expect(segs[0]!.from).toEqual(range.from);
    expect(segs.at(-1)!.to).toEqual(range.to);
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i]!.from).toEqual(segs[i - 1]!.to);
    }
  });
});

describe('report — coverage notice names the cause', () => {
  it('distinguishes missing data from a shallow tier', () => {
    const lines = describeCoverage([
      { from: d('2026-09-01'), to: d('2026-10-12'), depth: 'prompt-level' },
      { from: d('2026-10-12'), to: d('2026-10-18'), depth: 'full' },
    ]);
    expect(lines[0]).toMatch(/prompt-level only/);
    expect(lines[1]).toMatch(/full depth/);
  });

  it('does not round a few hours up to a whole day', () => {
    // Hours since the last session are not a day of missing history.
    const lines = describeCoverage([
      {
        from: new Date('2026-10-19T02:47:00.000Z'),
        to: new Date('2026-10-19T06:47:00.000Z'),
        depth: 'none',
      },
    ]);
    expect(lines[0]).toContain('(4h)');
    expect(lines[0]).not.toContain('(1d)');
  });

  it('includes the period and its length on every line', () => {
    const lines = describeCoverage([
      { from: d('2026-10-11'), to: d('2026-10-18'), depth: 'full' },
    ]);
    expect(lines[0]).toContain('2026-10-11 → 2026-10-18');
    expect(lines[0]).toContain('(7d)');
  });
});
