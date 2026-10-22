/**
 * The scorer, whose failure mode is flattering itself.
 *
 * Every number `score` reports is turn-anchored: a finding must sit within
 * `TURN_TOLERANCE` of located evidence. The three denominators differ only in
 * the unit and in whether the label must match. The temptation this file exists
 * to block is the fourth, easier reading — "did the judge say anything about
 * this session" — which scores 76% where the honest one scores 60%, because it
 * credits sessions where the judge spoke and hit nothing real.
 */

import { describe, expect, it } from 'vitest';
import { score, TURN_TOLERANCE, type GoldEpisode, type JudgeOutput } from '../src/gold.ts';

const episode = (over: Partial<GoldEpisode> = {}): GoldEpisode => ({
  sessionSha: 's1',
  misalignmentId: 'm1',
  name: 'something went wrong',
  confidence: 'high',
  dimensions: ['constraint_violation'],
  allSymptoms: ['S3'],
  quotes: ['do not add dependencies'],
  ...over,
});

const finding = (over: Partial<JudgeOutput> = {}): JudgeOutput => ({
  sessionId: 's1',
  dimension: 'constraint_violation',
  turns: [100],
  ...over,
});

describe('session-level recall — the headline', () => {
  it('counts a session whose episode was found and anchored', () => {
    const s = score([episode()], new Map([['s1:m1', [100]]]), [finding()], ['s1']);
    expect(s.sessionLevel).toEqual({ withEpisode: 1, caught: 1, recall: 1 });
  });

  it('does NOT count a session where the judge spoke but anchored nothing real', () => {
    // A finding 500 turns from the only evidence. The judge said something
    // about this session; it was not this episode.
    const s = score([episode()], new Map([['s1:m1', [100]]]), [finding({ turns: [600] })], ['s1']);
    expect(s.sessionLevel.caught).toBe(0);
    expect(s.sessionLevel.recall).toBe(0);
  });

  it('counts a session once even when it holds several episodes', () => {
    // The product surfaces ONE thing to try, so finding one real problem in a
    // three-problem session is a served user, not two misses.
    const eps = [
      episode({ misalignmentId: 'm1' }),
      episode({ misalignmentId: 'm2' }),
      episode({ misalignmentId: 'm3' }),
    ];
    const located = new Map([['s1:m1', [100]], ['s1:m2', [900]], ['s1:m3', [1700]]]);
    const s = score(eps, located, [finding()], ['s1']);

    expect(s.sessionLevel).toEqual({ withEpisode: 1, caught: 1, recall: 1 });
    // ...while the stricter units still record what was missed.
    expect(s.episodeLevel.caught).toBe(1);
    expect(s.episodeLevel.total).toBe(3);
  });
});

describe('episode-level recall — label-free, still turn-anchored', () => {
  it('credits a located episode we labelled differently', () => {
    const s = score(
      [episode({ dimensions: ['constraint_violation'] })],
      new Map([['s1:m1', [100]]]),
      [finding({ dimension: 'misread_intent' })],
      ['s1'],
    );
    expect(s.episodeLevel.caught).toBe(1);
    // The exact-dimension number must still show the disagreement.
    expect(s.matched).toBe(0);
    expect(s.confusion['misread_intent -> constraint_violation']).toBe(1);
  });

  it('does not credit the right label in the wrong place', () => {
    const s = score([episode()], new Map([['s1:m1', [100]]]), [finding({ turns: [600] })], ['s1']);
    expect(s.episodeLevel.caught).toBe(0);
    expect(s.rightDimensionWrongPlace).toBe(1);
  });
});

describe('the tolerance is a boundary, not a suggestion', () => {
  it('accepts a finding exactly at the tolerance and rejects one past it', () => {
    const located = new Map([['s1:m1', [100]]]);
    const at = score([episode()], located, [finding({ turns: [100 + TURN_TOLERANCE] })], ['s1']);
    const past = score([episode()], located, [finding({ turns: [100 + TURN_TOLERANCE + 1] })], ['s1']);
    expect(at.matched).toBe(1);
    expect(past.matched).toBe(0);
  });
});

describe('out-of-scope episodes are not failures', () => {
  it('excludes an S1/S5/S6-only episode from every denominator', () => {
    const s = score(
      [episode({ dimensions: [], allSymptoms: ['S5'] })],
      new Map(),
      [],
      ['s1'],
    );
    expect(s.outOfScope).toBe(1);
    expect(s.inScope).toBe(0);
    expect(s.sessionLevel.withEpisode).toBe(0);
    expect(s.episodeLevel.total).toBe(0);
  });
});

describe('a multi-label episode cannot be scored twice by one finding', () => {
  it('matches one claim, leaving the other recorded as unmet', () => {
    const s = score(
      [episode({ dimensions: ['constraint_violation', 'misread_intent'] })],
      new Map([['s1:m1', [100]]]),
      [finding()],
      ['s1'],
    );
    expect(s.inScope).toBe(2);
    expect(s.matched).toBe(1);
    // One episode, caught. This is exactly why claim-level understates.
    expect(s.episodeLevel.caught).toBe(1);
  });
});
