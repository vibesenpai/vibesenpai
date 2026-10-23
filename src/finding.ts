/**
 * Finding identity and merge.
 *
 * ── Two keys, and why ────────────────────────────────────────────────────────
 *
 * `id` is per-session: `hash(dimension + sessionId + subject)`.
 * `subjectId` is cross-session: `hash(dimension + project + subject)`.
 *
 * Both are keyed on the **subject** and never on the evidence. That is the whole
 * point: if identity included evidence extent, a finding with 7 violations would
 * become a *different* finding at the 8th — so the running score would lose its
 * history and anyone who dismissed it would get nagged again. The subject is
 * what a person recognises ("use pnpm, never npm"); the evidence is what grew.
 *
 * ── The merge fixes a bug deferred from M1 ───────────────────────────────────
 *
 * M1 shipped non-overlapping windows partly because `occurrences` would
 * double-count a turn appearing in two windows. The real problem was that
 * `occurrences` had no definition independent of how the session was windowed.
 *
 * It does now: **`occurrences` is the number of distinct anchors**, where an
 * anchor is the turn that identifies one instance. Merging two windows that
 * share a turn counts it once, so the number describes the session rather than
 * the slicing, and `stride` becomes safe to lower.
 *
 * ── Why anchors are not just the evidence ────────────────────────────────────
 *
 * The first version used `evidence.length`, which real data immediately broke.
 * `inaccurate_self_report` cites **two** turns per instance — the failing check
 * and the claim that contradicts it — so a single false claim reported
 * `occurrences: 2`. Meanwhile `tool_loop` cites three repeated calls and three
 * *is* the right count.
 *
 * So a candidate may name its anchors explicitly: one per instance. When it does
 * not, every evidence ref is an instance, which is the common case.
 */

import { createHash } from 'node:crypto';
import { stamp } from './schema.ts';
import type { OccurrenceRow } from './store.ts';
import type {
  Confidence,
  Finding,
  Method,
  Outcome,
  Polarity,
  TurnRef,
} from './types.ts';

/** What a detector returns. Identity, timestamps and merge are not its job. */
export type Candidate = {
  dimension: string;
  /** Human-readable and stable — it is half of both identity keys. */
  subject: string;
  /** Every turn worth showing. May include supporting context. */
  evidence: TurnRef[];
  /**
   * One ref per instance, when that differs from the evidence.
   *
   * Omit when every evidence ref is itself an instance. Supplying it is what
   * keeps `occurrences` meaning "how many times this happened" rather than "how
   * many turns we cited".
   */
  anchors?: TurnRef[];
  confidence: Confidence;
  method: Method;
  polarity: Polarity;
  requiresOutcome: boolean;
  outcome?: Outcome;
};

function sha(parts: string[]): string {
  const h = createHash('sha256');
  for (const p of parts) {
    // Length-prefixed so that ("ab","c") and ("a","bc") cannot collide — a
    // dimension named `x` with subject `y:z` must not equal `x:y` with `z`.
    h.update(String(p.length)).update(':').update(p);
  }
  return h.digest('hex').slice(0, 16);
}

export function findingId(dimension: string, sessionId: string, subject: string): string {
  return sha([dimension, sessionId, subject]);
}

export function subjectIdOf(dimension: string, project: string, subject: string): string {
  return sha([dimension, project, subject]);
}

/**
 * Deduplicate refs by uuid, in transcript order.
 *
 * **Sorted by `seq`, not by insertion.** A thread-scoped detector runs once per
 * actor, so merging two actors' findings appended one actor's turns after the
 * other's: a loop shared by the main thread and a subagent cited
 * `turns 1,5,9,3,7,11`. The finding was right and unreadable — evidence a
 * person is meant to follow has to be in the order it happened.
 *
 * Refs without a `seq` keep their relative order at the end: `seq` is a derived
 * position and may legitimately be absent, and inventing one to sort by would
 * be worse than leaving them last.
 */
export function dedupeEvidence(refs: TurnRef[]): TurnRef[] {
  const seen = new Set<string>();
  const out: TurnRef[] = [];
  for (const r of refs) {
    if (seen.has(r.uuid)) continue;
    seen.add(r.uuid);
    out.push(r);
  }
  return out.sort((a, b) => {
    if (a.seq === undefined) return b.seq === undefined ? 0 : 1;
    if (b.seq === undefined) return -1;
    return a.seq - b.seq;
  });
}

export type MaterialiseInput = {
  candidate: Candidate;
  sessionId: string;
  project: string;
  now: string;
};

/** A `Candidate` becomes a `Finding`: identity assigned, evidence deduplicated. */
export function materialise(input: MaterialiseInput): Finding {
  const { candidate: c, sessionId, project, now } = input;
  const evidence = dedupeEvidence(c.evidence);
  const anchors = dedupeEvidence(c.anchors ?? c.evidence);
  return {
    ...stamp('finding'),
    id: findingId(c.dimension, sessionId, c.subject),
    subjectId: subjectIdOf(c.dimension, project, c.subject),
    dimension: c.dimension,
    subject: c.subject,
    sessionId,
    project,
    evidence,
    anchors,
    occurrences: anchors.length,
    confidence: c.confidence,
    method: c.method,
    requiresOutcome: c.requiresOutcome,
    ...(c.outcome !== undefined ? { outcome: c.outcome } : {}),
    polarity: c.polarity,
    firstSeen: now,
    lastSeen: now,
    surfaced: false,
  };
}

/**
 * Combine two findings that share an `id`.
 *
 * Evidence unions by uuid and `occurrences` follows from it, so a turn seen in
 * two overlapping windows is counted once. `firstSeen` keeps the earlier value —
 * it is the age of the pattern, and letting a re-detection reset it would erase
 * exactly the history the running score reads.
 *
 * `surfaced` is sticky-true: once an ambient nudge has shown a finding, a later
 * merge must not make it surfaceable again. `dismissed` and `suppressedBy` are
 * preserved for the same reason — they are the user's decisions, and a merge is
 * not a reason to revisit them.
 */
export function mergeFindings(a: Finding, b: Finding): Finding {
  if (a.id !== b.id) {
    throw new Error(`refusing to merge different findings: ${a.id} vs ${b.id}`);
  }
  const evidence = dedupeEvidence([...a.evidence, ...b.evidence]);
  const anchors = dedupeEvidence([...(a.anchors ?? a.evidence), ...(b.anchors ?? b.evidence)]);
  const earlier = a.firstSeen <= b.firstSeen ? a : b;
  const later = a.lastSeen >= b.lastSeen ? a : b;
  const reasons = mergeReasons(a.reasons, b.reasons);

  return {
    ...later,
    evidence,
    anchors,
    occurrences: anchors.length,
    ...(reasons !== undefined ? { reasons } : {}),
    firstSeen: earlier.firstSeen,
    lastSeen: later.lastSeen,
    surfaced: a.surfaced || b.surfaced,
    ...(a.dismissed ?? b.dismissed ? { dismissed: a.dismissed ?? b.dismissed } : {}),
    ...(a.suppressedBy ?? b.suppressedBy
      ? { suppressedBy: a.suppressedBy ?? b.suppressedBy }
      : {}),
  } as Finding;
}

/**
 * Add two reason tallies.
 *
 * Summed rather than replaced: merging two halves of the same finding must not
 * lose that two of its instances failed for one reason and one for another,
 * which is the whole value of the tally.
 */
function mergeReasons(
  a: Record<string, number> | undefined,
  b: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const out: Record<string, number> = { ...a };
  for (const [k, n] of Object.entries(b)) out[k] = (out[k] ?? 0) + n;
  return out;
}

/** Fold candidates from many windows into one finding per subject. */
export function collect(
  candidates: Candidate[],
  ctx: { sessionId: string; project: string; now: string },
): Finding[] {
  const byId = new Map<string, Finding>();
  for (const c of candidates) {
    const f = materialise({ candidate: c, ...ctx });
    const existing = byId.get(f.id);
    byId.set(f.id, existing === undefined ? f : mergeFindings(existing, f));
  }
  return [...byId.values()];
}

/** The commonest harness reason in a tally, or none when there is no tally. */
function topReason(reasons: Record<string, number> | undefined): string | undefined {
  if (reasons === undefined) return undefined;
  const best = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0];
  return best?.[0];
}

/**
 * A finding, flattened to the atomic rows a store can hold.
 *
 * ── Why one row per anchor ─────────────────────────────────────────────────
 *
 * `anchors` is already defined as **one ref per instance** — the turn that
 * identifies a single occurrence, distinct from `evidence`, which may cite
 * supporting turns. So the atomic fact exists in this module already; it has
 * simply never been persisted.
 *
 * Rule findings are not stored at all today. The standing pass re-derives
 * every one of them from scratch every ten minutes, which is why nothing can
 * contribute findings between passes — and why the rolled-up file it writes
 * keeps only the single worst subject per dimension, losing the rest.
 *
 * Pure on purpose: this module does no I/O, so it maps and the caller writes.
 */
export function occurrencesOf(findings: Finding[]): OccurrenceRow[] {
  const rows: OccurrenceRow[] = [];
  for (const f of findings) {
    const reason = topReason(f.reasons);
    for (const anchor of f.anchors) {
      rows.push({
        // Content-hashed from the finding's own identity plus the anchor, so a
        // re-run upserts over itself rather than duplicating. The anchor is in
        // the key because it is what makes the row atomic.
        id: createHash('sha256').update(`rule\0${f.id}\0${anchor.uuid}`).digest('hex').slice(0, 16),
        sessionId: f.sessionId,
        dimension: f.dimension,
        tier: 'rule' as const,
        subject: f.subject,
        anchorUuid: anchor.uuid,
        confidence: f.confidence,
        // `reasons` is a tally keyed by the harness's own reason. The
        // commonest one labels the row; the full tally stays answerable from
        // the rows themselves, which is the point of the atomic grain.
        ...(reason === undefined ? {} : { reason }),
        at: f.lastSeen,
      });
    }
  }
  return rows;
}
