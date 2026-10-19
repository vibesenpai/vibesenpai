/**
 * The detector registry and the runner.
 *
 * ── Denominators are computed here, not by detectors ─────────────────────────
 *
 * Every rate the running score displays needs a denominator — edits, turns,
 * success claims. Those are **per-session totals**, while detectors run
 * per-window. If each detector incremented a counter, a run that stopped
 * halfway would bank partial findings against partial denominators, and every
 * rate would be quietly wrong in a way no output would reveal.
 *
 * So the runner makes one pass over the session's events for denominators, and
 * detectors only ever emit candidates.
 *
 * ── Failure isolation ───────────────────────────────────────────────────────
 *
 * Principle Zero: a broken analyzer must never break a session. One detector
 * throwing must not lose the other detectors' findings for that window, nor the
 * remaining windows. Failures are counted and reported rather than swallowed —
 * a silent zero would read as "nothing found".
 */

import { collect, type Candidate } from '../finding.ts';
import { buildWindows, type SkeletonOptions } from '../skeleton.ts';
import type { Event, Finding, Preset } from '../types.ts';
import type { Detector, SessionFacts } from './types.ts';
import { hasSuccessClaim } from './claims.ts';
import { toolLoop } from './tool-loop.ts';
import { revertChurn } from './revert-churn.ts';
import { inaccurateSelfReport } from './inaccurate-self-report.ts';

export type { Detector, DetectorContext, SessionFacts } from './types.ts';
export { isSuccessClaim, hasSuccessClaim } from './claims.ts';

/**
 * All detectors, in the order PLAN.md specifies: cheapest and most certain
 * first, so the framework is exercised by structurally checkable rules before
 * the lexical ones arrive.
 */
export function allDetectors(): Detector[] {
  return [toolLoop(), revertChurn(), inaccurateSelfReport()];
}

const PRESET_RANK: Record<Preset, number> = { core: 0, standard: 1, all: 2 };

/**
 * Which detectors a preset runs.
 *
 * `core` is the trust-building set. A dimension joins it only when it is
 * `certain` or `high` and needs no model — the first finding a stranger sees
 * decides whether they keep the tool.
 */
export function detectorsFor(preset: Preset, only?: string[]): Detector[] {
  const wanted = only === undefined ? undefined : new Set(only);
  return allDetectors().filter((d) => {
    if (wanted !== undefined) return wanted.has(d.dimension);
    return PRESET_RANK[d.preset] <= PRESET_RANK[preset];
  });
}

/** Per-session totals every rate divides by. One pass, never incremental. */
export type Denominators = {
  turnCount: number;
  editCount: number;
  toolCallCount: number;
  verifiedEditCount: number;
  successClaimCount: number;
};

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function countDenominators(
  events: Event[],
  verificationCommands: string[],
): Denominators {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const d: Denominators = {
    turnCount: 0,
    editCount: 0,
    toolCallCount: 0,
    verifiedEditCount: 0,
    successClaimCount: 0,
  };

  // An edit is "verified" when a verification command runs after it. Tracked as
  // a pending set rather than a per-edit scan, so one test run can clear every
  // edit that preceded it — which is what actually happened.
  let pendingEdits = 0;

  for (const e of sorted) {
    if (e.turnType === 'user_prompt') d.turnCount++;
    if (e.turnType === 'tool_use') {
      d.toolCallCount++;
      if (EDIT_TOOLS.has(e.toolName ?? '')) {
        d.editCount++;
        pendingEdits++;
      } else if (isVerification(e, verificationCommands)) {
        d.verifiedEditCount += pendingEdits;
        pendingEdits = 0;
      }
    }
    if (e.turnType === 'assistant_msg' && e.textSummary !== undefined) {
      if (hasSuccessClaim(e.textSummary)) d.successClaimCount++;
    }
  }

  return d;
}

/**
 * Does this call verify anything?
 *
 * Matched against the project's own commands rather than a fixed list, because
 * "the test command" is `pytest` in one repo and `npm test` in the next. An
 * empty list means this project has no known verification, which the caller must
 * treat as "cannot tell" rather than "nothing was verified".
 */
export function isVerification(e: Event, verificationCommands: string[]): boolean {
  if (verificationCommands.length === 0) return false;
  const cmd = e.command;
  if (cmd === undefined) return false;
  const lower = cmd.toLowerCase();
  return verificationCommands.some((v) => lower.includes(v.toLowerCase()));
}

export type RunInput = {
  events: Event[];
  session: SessionFacts;
  detectors?: Detector[];
  skeleton?: SkeletonOptions;
  now?: string;
};

export type RunResult = {
  findings: Finding[];
  denominators: Denominators;
  windows: number;
  /** Detectors that threw, by dimension. Reported, never swallowed. */
  failures: Record<string, number>;
};

export async function runDetectors(input: RunInput): Promise<RunResult> {
  const detectors = input.detectors ?? detectorsFor('core');
  const now = input.now ?? new Date().toISOString();
  const windows = buildWindows(input.session.sessionId, input.events, input.skeleton ?? {});

  const candidates: Candidate[] = [];
  const failures: Record<string, number> = {};

  for (const window of windows) {
    for (const d of detectors) {
      try {
        candidates.push(...(await d.detect({ window, session: input.session })));
      } catch {
        // One detector's bug must not cost the window's other findings.
        failures[d.dimension] = (failures[d.dimension] ?? 0) + 1;
      }
    }
  }

  return {
    findings: collect(candidates, {
      sessionId: input.session.sessionId,
      project: input.session.project,
      now,
    }),
    denominators: countDenominators(input.events, input.session.verificationCommands),
    windows: windows.length,
    failures,
  };
}
