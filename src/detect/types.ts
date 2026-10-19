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
import type { VerificationLookup } from '../verify.ts';
import type { Confidence, Denominator, Event, Method, Polarity, Preset, Skeleton } from '../types.ts';

export type DetectorContext = {
  /**
   * The events in this detector's scope, in `seq` order.
   *
   * Deliberately not a `Window`: the scope is the detector's own choice, and
   * only a window-scoped detector gets a skeleton at all.
   */
  events: Event[];
  /**
   * The skeleton, for window-scoped detectors only.
   *
   * Present when `scope: 'window'`. Thread-scoped detectors have no single
   * skeleton — their scope spans many windows — and must not invent one.
   */
  skeleton?: Skeleton;
  /** Facts the scope cannot see on its own. */
  session: SessionFacts;
};

/**
 * How much of the transcript a detector evaluates at once.
 *
 * ── Why this is a per-detector choice ───────────────────────────────────────
 *
 * The first version ran every detector per window, conflating "the unit a model
 * can afford to read" with "the scope a rule evaluates". They are not the same
 * thing, and the measurement is damning: of 363 genuinely verified edits across
 * the corpora, **293 — 81% — are verified by a command in a *later* window**.
 * A per-window `no_verification` would have called every one of them unverified.
 *
 * That is a precision failure, not a recall one, which is the worse kind.
 */
export type Scope =
  /**
   * One 6–12 line window plus its event span. For detectors where locality is
   * the signal, and for the semantic tier, where a token budget binds.
   */
  | 'window'
  /**
   * One whole thread — the main thread, or one subagent — at full length.
   *
   * For rules where *locality* is the signal. Thread rather than session
   * because a flat array interleaves subagent events among main-thread ones,
   * which breaks consecutive-run detection and merges work belonging to
   * different actors.
   */
  | 'thread'
  /**
   * Every thread, in one pass — "did this happen anywhere, by anyone?"
   *
   * The default for rules that are not about locality. The cross-actor case is
   * real: a subagent edits a file and the main thread runs the tests. Scoped to
   * a thread, that edit looks unverified.
   */
  | 'session'
  /**
   * Across sessions — "has this happened before?"
   *
   * Declared but **not implemented**: it needs stored history, which arrives
   * with the store in M3. `constraint_decay` lives here, because a constraint
   * stated in one session is violated in the next. Declared now so the runner
   * refuses it explicitly rather than silently evaluating the wrong span.
   */
  | 'project';

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
   * What verifies code in this project — **learned**, not configured.
   *
   * A hardcoded list was built first and discarded: there are thousands of
   * toolchains, so accuracy would track how well the author guessed the user's
   * stack. See src/verify.ts.
   *
   * `cold` means nothing has been learned yet, which is a different claim from
   * "nothing was verified" and must not produce findings. The spec is explicit
   * that a project with no known test suite needs a state, not a finding.
   */
  verification: VerificationLookup;
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
