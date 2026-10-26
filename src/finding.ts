/**
 * Finding identity and merge. `id` is per session, `subjectId` across sessions; both hash the subject,
 * never the evidence, so a finding keeps its identity as it grows.
 * `occurrences` is the number of distinct anchors (one per instance), so it is independent of windowing.
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
  /** One ref per instance, when that differs from the evidence. Omit when every ref is an instance. */
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
    // Length-prefixed so ("ab","c") and ("a","bc") cannot collide.
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

/** Deduplicate refs by uuid, sorted by `seq` (refs without one go last, in order). */
function dedupeEvidence(refs: TurnRef[]): TurnRef[] {
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

type MaterialiseInput = {
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
 * Combine two findings that share an `id`: evidence unions by uuid, `firstSeen` keeps the earlier.
 * `surfaced`, `dismissed` and `suppressedBy` are sticky: a merge never revisits the user's decisions.
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

/** Add two reason tallies (summed, not replaced). */
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

/** A finding flattened to one store row per anchor. Pure: the caller writes. */
export function occurrencesOf(findings: Finding[]): OccurrenceRow[] {
  const rows: OccurrenceRow[] = [];
  for (const f of findings) {
    const reason = topReason(f.reasons);
    for (const anchor of f.anchors) {
      rows.push({
        // Content hash of finding id + anchor, so a re-run upserts rather than duplicates.
        id: createHash('sha256').update(`rule\0${f.id}\0${anchor.uuid}`).digest('hex').slice(0, 16),
        sessionId: f.sessionId,
        dimension: f.dimension,
        tier: 'rule' as const,
        subject: f.subject,
        anchorUuid: anchor.uuid,
        confidence: f.confidence,
        // The commonest harness reason labels the row.
        ...(reason === undefined ? {} : { reason }),
        at: f.lastSeen,
      });
    }
  }
  return rows;
}
