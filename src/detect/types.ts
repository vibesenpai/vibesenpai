/**
 * The detector contract. Detectors are async (the semantic tier calls a model) and must not throw.
 * They return candidates only; identity, merging and denominators belong to the runner.
 * `events` omits command text, so reading it is a build error: CLAUDE.md "A detector reads structure".
 */

import type { Candidate } from '../finding.ts';
import type {
  Confidence,
  Denominator,
  Method,
  Polarity,
  Preset,
  Skeleton,
  StructuralEvent,
} from '../types.ts';

export type DetectorContext = {
  /** The events in this detector's scope, in `seq` order. */
  events: StructuralEvent[];
  /** Present only when `scope: 'window'`. */
  skeleton?: Skeleton;
  /** Facts the scope cannot see on its own. */
  session: SessionFacts;
};

// How much a detector evaluates at once: .claude/rules/detectors.md, "Scope is a property of the detector".
export type Scope =
  /** One 6–12 line window; for the semantic tier, where a token budget binds. */
  | 'window'
  /** One whole thread (main or one subagent), for rules where locality is the signal. */
  | 'thread'
  /** Every thread at once: "did this happen anywhere, by anyone?" */
  | 'session'
  /** Across sessions. Declared but not implemented, so the runner refuses it. */
  | 'project';

// Facts a detector needs that are not in its scope. Keep it small.
export type SessionFacts = {
  sessionId: string;
  project: string;
  /** True when the session is still being written to. */
  live: boolean;
};

export type Detector = {
  dimension: string;
  /** How much of the transcript this detector needs at once. */
  scope: Scope;
  /** Which direction is good. `neutral` carries no value judgment. */
  polarity: Polarity;
  confidence: Confidence;
  method: Method;
  /** Suppressed entirely until outcome classification exists (M2b). */
  requiresOutcome: boolean;
  /** What the running score divides by. Rates, never raw counts. */
  denominator: Denominator;
  /** Which preset includes this dimension by default. */
  preset: Preset;
  /** One line, shown beside the finding. Never a bare count. */
  describe(subject: string, occurrences: number): string;
  detect(ctx: DetectorContext): Promise<Candidate[]>;
};
