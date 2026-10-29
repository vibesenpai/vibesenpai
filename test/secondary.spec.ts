/** Secondary kinds: a record can be more than one kind, as the paper's labels are; the main kind stays in charge. */

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLabels, renderLabel, SECONDARY_MAX, type JudgeEpisode, type Lookbacks } from '../src/judge/prompt.ts';
import { buildLookback } from '../src/judge/lookback.ts';
import { readJudgeState, recordPass } from '../src/judge/state.ts';
import { renderJudged } from '../src/render.ts';
import { score, type GoldEpisode } from '../scripts/gold.ts';

const episode: JudgeEpisode = {
  sessionId: 's1',
  name: 'Rewrote Code When Asked To Edit Prose',
  description: 'The developer asked for prose edits only; the agent also rewrote the parser.',
  alignmentGoal: 'instruction',
  confidence: 'high',
  evidence: [{ quote: 'only edit the prose', context: 'the rule', turns: [10] }],
};

const label = (row: Record<string, unknown>): string =>
  JSON.stringify({ labels: [{ record: 1, reasoning: 'r', other_descriptor: null, ...row }] });

describe('secondary_dimensions in the label stage', () => {
  it('asks for them in the reply format', () => {
    expect(renderLabel([episode])).toMatch(/"secondary_dimensions":\[\]/);
  });

  it('keeps valid kinds, drops the main kind, `other`, unknowns and repeats, and caps the list', () => {
    const [f] = parseLabels(
      label({ dimension: 'constraint_violation', secondary_dimensions: ['constraint_violation', 'overreach', 'other', 'code_smell', 'overreach', 'misread_intent', 'inaccurate_self_report'] }),
      [episode],
    ).findings;
    expect(f?.secondaryDimensions).toEqual(['overreach', 'misread_intent']);
    expect(f?.secondaryDimensions).toHaveLength(SECONDARY_MAX);
  });

  it('omits the field when there are none', () => {
    const [f] = parseLabels(label({ dimension: 'overreach', secondary_dimensions: [] }), [episode]).findings;
    expect(f).not.toHaveProperty('secondaryDimensions');
  });

  it('with lookback, drops a secondary kind that needs a source the finding does not have', () => {
    const lb: Lookbacks = new Map([['s1', buildLookback({ prompts: [], instructions: [] }, 'prose', 10, 4000, [11])]]);
    const [f] = parseLabels(label({ dimension: 'overreach', secondary_dimensions: ['misread_intent', 'inaccurate_self_report'], established: null }), [episode], lb).findings;
    expect(f?.secondaryDimensions).toEqual(['inaccurate_self_report']);
  });
});

describe('secondary kinds, once kept', () => {
  it('survive the store and read as "also" on the kind line', () => {
    const [f] = parseLabels(label({ dimension: 'constraint_violation', secondary_dimensions: ['overreach'] }), [episode]).findings;
    const dir = mkdtempSync(join(tmpdir(), 'as-secondary-'));
    recordPass(dir, [{ ...f!, at: '2026-10-27T00:00:00.000Z' }], new Map());
    const [back] = readJudgeState(dir).findings;
    expect(back?.secondaryDimensions).toEqual(['overreach']);
    expect(back?.turns).toEqual([10]);
    expect(renderJudged([back!], 0).join('\n')).toMatch(/constraint_violation.* · also overreach/);
  });

  it('count as claims in the gold scorer, once per kind', () => {
    const gold: GoldEpisode = {
      sessionSha: 's1', misalignmentId: 'm1', name: 'n', confidence: 'high',
      dimensions: ['constraint_violation', 'overreach'], allSymptoms: ['S3', 'S4'], quotes: [],
    };
    const located = new Map([['s1:m1', [10]]]);
    const both = score([gold], located, [{ sessionId: 's1', dimension: 'constraint_violation', secondaryDimensions: ['overreach'], turns: [10] }], ['s1']);
    expect(both.matched).toBe(2);
    expect(both.byDimension['overreach']).toEqual({ inScope: 1, matched: 1 });
    expect(both.unmatched).toBe(0);
    const main = score([gold], located, [{ sessionId: 's1', dimension: 'constraint_violation', turns: [10] }], ['s1']);
    expect(main.matched).toBe(1);
  });
});

describe('caught at all, under any of the four kinds', () => {
  const gold: GoldEpisode = {
    sessionSha: 's1', misalignmentId: 'm1', name: 'n', confidence: 'high',
    dimensions: ['overreach'], allSymptoms: ['S4'], quotes: [],
  };
  const located = new Map([['s1:m1', [10]]]);

  it('counts an overreach episode the judge called a violation, at the right place', () => {
    const s = score([gold], located, [{ sessionId: 's1', dimension: 'constraint_violation', turns: [12] }], ['s1']);
    expect(s.matched).toBe(0);
    expect(s.caughtAnyKind.byDimension['overreach']).toEqual({ total: 1, caught: 1 });
  });

  it('does not count `other`, nor a finding in the wrong place', () => {
    const other = score([gold], located, [{ sessionId: 's1', dimension: 'other', turns: [10] }], ['s1']);
    expect(other.caughtAnyKind.caught).toBe(0);
    const far = score([gold], located, [{ sessionId: 's1', dimension: 'overreach', turns: [500] }], ['s1']);
    expect(far.caughtAnyKind.caught).toBe(0);
  });
});
