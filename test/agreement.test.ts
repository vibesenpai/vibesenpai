/**
 * The surfaces must agree.
 *
 * This file exists because two of them did not, and it was found by reading
 * output rather than by a test: `standing` reported 23 findings while the HTML
 * report reported 22, because one summed occurrences and the other counted
 * grouped findings. A reader who opens both sees a discrepancy they cannot
 * explain, and the natural conclusion is that the tool is unreliable.
 *
 * Five surfaces render the same facts — `now`, `standing`, the text report, the
 * HTML report, and the session-start block — and every one of them built its
 * own totals. `leadSegments` is now the single place that turns those facts
 * into a sentence; these tests pin that it stays single.
 */
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
    // The line used to read `11,000+ tokens written and discarded · 23
    // findings`, which invites exactly one reading: that twenty-three findings
    // cost eleven thousand tokens. Nineteen of them have no price at all —
    // `costFor` handles `edit_retry` and `redundant_call` and nothing else.
    const seg = leadSegments(facts());
    expect(seg.rest).toContain('on 4 findings');
    expect(seg.rest).toContain('19 more flagged by a model');
    // The total must not sit adjacent to the figure.
    expect(`${seg.figure}${seg.rest}`).not.toMatch(/tokens[^.]*·\s*23 findings/);
  });

  it('omits the model clause when the judge found nothing', () => {
    const seg = leadSegments(facts({ judgedCount: 0, total: 4 }));
    expect(seg.rest).not.toContain('flagged by a model');
    expect(seg.rest).toContain('on 4 findings');
  });

  it('says so plainly when only the judge found anything', () => {
    const seg = leadSegments(facts({ ruleCount: 0, wasted: 0, total: 19 }));
    expect(seg.figure).toBe('19 findings');
    expect(seg.rest).toBe(' flagged by a model');
  });

  it('falls back to a count when nothing could be priced', () => {
    const seg = leadSegments(facts({ wasted: 0 }));
    expect(seg.figure).toBe('23 findings');
    expect(seg.rest).toContain('2460 edits');
  });

  it('keeps the denominator when nothing was found', () => {
    // A clean bill of health, per PLAN.md:21. "no findings" alone reads as
    // "we did not look"; the denominator is what makes it a real statement.
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
