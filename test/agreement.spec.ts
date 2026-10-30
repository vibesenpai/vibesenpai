/** The five surfaces must agree on totals; `leadSegments` is the single place that phrases them. */
import { describe, expect, it } from 'vitest';
import { leadSegments, type LeadFacts } from '../src/render.ts';

const facts = (over: Partial<LeadFacts> = {}): LeadFacts => ({
  ruleCount: 4,
  judgedCount: 19,
  total: 23,
  wasted: 11_000,
  editCount: 2460,
  ...over,
});

describe('the lead attributes the price to the tier that produced it', () => {
  it('never implies the judge findings cost tokens', () => {
    // The token figure must not read as the cost of every finding: only some dimensions are priced.
    const seg = leadSegments(facts());
    expect(seg.rest).toContain('on 4 findings');
    expect(seg.rest).toContain('19 more flagged');
    // The total must not sit adjacent to the figure.
    expect(`${seg.figure}${seg.rest}`).not.toMatch(/tokens[^.]*·\s*23 findings/);
  });

  it('omits the model clause when the judge found nothing', () => {
    const seg = leadSegments(facts({ judgedCount: 0, total: 4 }));
    expect(seg.rest).not.toContain('flagged');
    expect(seg.rest).toContain('on 4 findings');
  });

  it('says so plainly when only the judge found anything', () => {
    const seg = leadSegments(facts({ ruleCount: 0, wasted: 0, total: 19 }));
    expect(seg.figure).toBe('19 findings');
    expect(seg.rest).toBe(' flagged');
  });

  it('falls back to a count when nothing could be priced', () => {
    const seg = leadSegments(facts({ wasted: 0 }));
    expect(seg.figure).toBe('23 findings');
    expect(seg.rest).toContain('2460 edits');
  });

  it('keeps the denominator when nothing was found', () => {
    // "no findings" needs its denominator, or it reads as "we did not look".
    const seg = leadSegments(facts({ ruleCount: 0, judgedCount: 0, total: 0, wasted: 0 }));
    expect(seg.figure).toBeUndefined();
    expect(seg.rest).toBe('no findings across 2460 edits');
  });

  it('uses real plurals throughout', () => {
    const one = leadSegments(facts({ ruleCount: 1, judgedCount: 1, total: 2 }));
    expect(one.rest).toContain('on 1 finding');
    expect(one.rest).not.toContain('1 findings');
    expect(one.rest).not.toContain('(s)');
  });
});
