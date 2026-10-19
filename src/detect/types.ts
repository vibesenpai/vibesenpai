/**
 * The detector contract.
 *
 * ── Async from day one ───────────────────────────────────────────────────────
 *
 * Every detector returns a promise even though M2a's are all pure synchronous
 * rules. CLAUDE.md requires it: the semantic tier calls a model, and converting
 * a synchronous interface to async later would touch every detector, the
 * registry, and the runner at once.
 *
 * ── What a detector may and may not do ───────────────────────────────────────
 *
 * It reads one window and returns candidates. It does **not** assign identity,
 * merge, persist, or count denominators — those are session-level concerns, and
 * a detector that incremented a denominator per window would make every rate
 * wrong on a partial run.
 *
 * It must not throw. Principle Zero: a broken analyzer must never break a
 * session, so the runner isolates failures, but a detector that returns no
 * candidates when confused is better than one that throws and loses the rest of
 * the window's findings.
 */

import type { Candidate } from '../finding.ts';
import type { Window } from '../skeleton.ts';
import type { Confidence, Denominator, Method, Polarity, Preset } from '../types.ts';

export type DetectorContext = {
  window: Window;
  /** Session-level facts a window cannot see on its own. */
  session: SessionFacts;
};

/**
 * Facts a detector needs that are not in its window.
 *
 * Deliberately small. Anything that grows here is a hint that the thing wants to
 * be a session-level pass rather than a detector.
 */
export type SessionFacts = {
  sessionId: string;
  project: string;
  /**
   * Verification commands this project actually has — from `package.json`
   * scripts, a Makefile, and the configured list.
   *
   * Empty means **no verification is available here**, which is a different
   * claim from "nothing was verified" and must not produce findings. The spec is
   * explicit that a project with no test suite needs a state, not a finding.
   */
  verificationCommands: string[];
  /** True when the session is still being written to. */
  live: boolean;
};

export type Detector = {
  dimension: string;
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
