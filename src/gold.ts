/**
 * The gold set: what the judge is measured against.
 *
 * ── A label has an author, and that is the whole design ────────────────────
 *
 * The judge cannot be its own examiner, and neither can any other model —
 * including whichever one proposed the labels in here. So every label records
 * **who made it**:
 *
 *   `proposed`   read by a model, with its reasoning attached. A candidate.
 *   `confirmed`  a person looked and agreed.
 *   `corrected`  a person looked and disagreed. The most valuable row in the
 *                file, because it is the only one that can catch a reviewer
 *                and a judge being wrong in the same direction.
 *
 * **Precision is reported against confirmed and corrected rows only.** A score
 * computed over proposed labels measures agreement between two models, which
 * is exactly the reassuring number this project must not produce. It is the
 * same failure as a fixture that encodes the bug it is meant to catch — and
 * that has already happened here three times.
 *
 * ── Why a stratified sample ────────────────────────────────────────────────
 *
 * Sampling at random from a corpus where most sessions contain nothing yields
 * a set of mostly-empty sessions, which measures only that the judge is quiet.
 * The interesting rows are the ones where a rule already found something (does
 * the judge agree?) and the long sessions where batching and the carry are
 * actually exercised.
 */

import type { JudgeDimension } from './judge.ts';

export type LabelSource = 'proposed' | 'confirmed' | 'corrected';

export type GoldLabel = {
  sessionId: string;
  /** Absent means "this session contains none of the four". */
  dimension?: JudgeDimension;
  /** Turns the label rests on. Required when a dimension is claimed. */
  turns?: number[];
  /** Why, in the labeller's own words. Carried so a reviewer can disagree. */
  why: string;
  source: LabelSource;
  /** Set when a person corrected a proposal, so both readings survive. */
  wasProposed?: { dimension?: JudgeDimension; why: string };
};

export type GoldSet = {
  v: number;
  /** Where the sessions came from, so the set can be rebuilt. */
  corpus: string;
  labels: GoldLabel[];
};

export const GOLD_VERSION = 1;

/** Rows a person has actually stood behind. The only ones that can score. */
export function adjudicated(set: GoldSet): GoldLabel[] {
  return set.labels.filter((l) => l.source === 'confirmed' || l.source === 'corrected');
}

export type Scored = {
  /** Of the judge's findings on adjudicated sessions, how many were right. */
  precision: number | undefined;
  /** Of the labelled findings, how many the judge found. */
  recall: number | undefined;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** Sessions scored. Reported because a precision over 3 rows is not a number. */
  sessions: number;
  /** Rows excluded for being unadjudicated, named so the gap is visible. */
  skippedProposed: number;
};

/**
 * Score a judge run against the set.
 *
 * A match requires the **same dimension on the same session with at least one
 * overlapping turn**. Dimension alone would credit the judge for finding the
 * right kind of problem in the wrong place, which is the shape of the first
 * hallucination this project saw: plausible claim, invented turn.
 */
export function score(
  set: GoldSet,
  found: { sessionId: string; dimension: JudgeDimension; turns: number[] }[],
): Scored {
  const gold = adjudicated(set);
  const sessions = new Set(gold.map((l) => l.sessionId));
  const inScope = found.filter((f) => sessions.has(f.sessionId));

  const claims = gold.filter((l) => l.dimension !== undefined);
  const used = new Set<number>();
  let tp = 0;

  for (const f of inScope) {
    const hit = claims.findIndex(
      (l, i) =>
        !used.has(i) &&
        l.sessionId === f.sessionId &&
        l.dimension === f.dimension &&
        (l.turns ?? []).some((t) => f.turns.includes(t)),
    );
    if (hit >= 0) {
      used.add(hit);
      tp++;
    }
  }

  const fp = inScope.length - tp;
  const fn = claims.length - tp;

  return {
    precision: inScope.length === 0 ? undefined : tp / inScope.length,
    recall: claims.length === 0 ? undefined : tp / claims.length,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    sessions: sessions.size,
    skippedProposed: set.labels.filter((l) => l.source === 'proposed').length,
  };
}

export type SampleInput = {
  sessionId: string;
  events: number;
  /** Whether a rule detector already fired here. */
  hasRuleFinding: boolean;
};

/**
 * Pick sessions worth a person's attention.
 *
 * Three strata, because each answers a different question:
 *
 *   **rule-positive** — does the judge agree with what is already known true?
 *     The one stratum that needs no labelling to be useful.
 *   **long** — are batching and the carry doing their job? A finding spanning
 *     a boundary only exists in a session long enough to have boundaries.
 *   **ordinary** — does the judge stay quiet? Most sessions contain nothing,
 *     and a judge that invents findings will do it here.
 *
 * Deterministic for a given input order, so a re-run proposes the same set and
 * labelling is not thrown away.
 */
export function stratifiedSample(all: SampleInput[], size: number): string[] {
  const byLength = [...all].sort((a, b) => b.events - a.events);
  const rulePositive = byLength.filter((s) => s.hasRuleFinding);
  const quiet = byLength.filter((s) => !s.hasRuleFinding);
  const long = quiet;
  // **The middle, not the tail.** Reversing the sort took the shortest
  // sessions, which on a real corpus are 2-event fragments: nothing to label,
  // and a judge staying quiet on them proves nothing. "Ordinary" has to mean
  // typical, so this walks outward from the median.
  const mid = Math.floor(quiet.length / 2);
  const ordinary: SampleInput[] = [];
  for (let d = 0; d < quiet.length; d++) {
    const lo = quiet[mid - d];
    const hi = quiet[mid + d];
    if (d > 0 && lo !== undefined) ordinary.push(lo);
    if (hi !== undefined) ordinary.push(hi);
  }

  const want = {
    rulePositive: Math.ceil(size * 0.4),
    long: Math.ceil(size * 0.3),
    ordinary: Math.floor(size * 0.3),
  };

  const out: string[] = [];
  const take = (from: SampleInput[], n: number): void => {
    for (const s of from) {
      if (out.length >= size || n <= 0) break;
      if (out.includes(s.sessionId)) continue;
      out.push(s.sessionId);
      n--;
    }
  };

  take(rulePositive, want.rulePositive);
  take(long, want.long);
  take(ordinary, want.ordinary);
  // Short of a full sample is reported by returning fewer, never padded with
  // whatever is left: a set that quietly became unstratified would misreport.
  return out;
}
