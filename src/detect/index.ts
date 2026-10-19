/**
 * The detector registry and the runner.
 *
 * ── Detectors get a text-free view ──────────────────────────────────────────
 *
 * `DetectorContext.events` is `StructuralEvent[]`, so a detector cannot read
 * `command`, `pattern` or `textSummary` — it is a build failure, not a review
 * comment. The runner still sees whole `Event`s, because it is the runner that
 * attaches a harness-owned label (`./labels.ts`) to an already-valid finding.
 * Detection therefore never depends on text; a harness change loses a label.
 *
 * ── Denominators are computed here, not by detectors ────────────────────────
 *
 * Every rate the running score displays needs a denominator. Those are
 * **per-session totals**, while detectors run per-window. If each detector
 * incremented a counter, a run that stopped halfway would bank partial findings
 * against partial denominators, and every rate would be quietly wrong in a way
 * no output would reveal.
 *
 * ── Aggregates are metadata, not findings ───────────────────────────────────
 *
 * A session-wide number has no turn to point at, and CLAUDE.md is explicit that
 * nothing is reported as a number without evidence behind it. So the token
 * totals live here, beside the other denominators, and are shown as the context
 * a reader needs — never as a finding, and never as a score.
 *
 * ── Failure isolation ───────────────────────────────────────────────────────
 *
 * Principle Zero: a broken analyzer must never break a session. One detector
 * throwing must not lose the other detectors' findings for that window, nor the
 * remaining windows. Failures are counted and reported rather than swallowed —
 * a silent zero would read as "nothing found".
 */

import { collect, type Candidate } from '../finding.ts';
import { buildWindows, threadsOf, type SkeletonOptions, type Window } from '../skeleton.ts';
import type { Event, Finding, Preset } from '../types.ts';
import type { Detector, DetectorContext, SessionFacts } from './types.ts';
import { EDIT_TOOLS, READ_TOOLS, editEvidenceOf, type EditEvidence } from '../edits.ts';

export type { Detector, DetectorContext, SessionFacts } from './types.ts';
// Re-exported so existing callers and tests keep one import site.
export { EDIT_TOOLS, READ_TOOLS, editEvidenceOf, type EditEvidence } from '../edits.ts';

/**
 * All detectors.
 *
 * **Empty by design, as of the 2026-10-19 reset.** The three that used to be
 * here read command verbs, result vocabulary and assistant prose to decide, and
 * over 1,139 real sessions produced 5 true positives against ~25 false
 * positives. They are gone; `GRAVEYARD.md` holds the evidence.
 *
 * The replacements land one at a time, each with its probe in
 * `scripts/measure-dimensions.ts`, in order of how clearly they can point at a
 * turn: `edit_retry`, `file_churn`, `context_reingest`, `redundant_call`. A
 * detector that disagrees with the measurement that justified it is wrong.
 */
export function allDetectors(): Detector[] {
  return [];
}

const PRESET_RANK: Record<Preset, number> = { core: 0, standard: 1, all: 2 };

/**
 * Which detectors a preset runs.
 *
 * `core` is the trust-building set. A dimension joins it only when it is
 * `certain` or `high` and needs no model — the first finding a stranger sees
 * decides whether they keep the tool. Measured frequency is **not** a reason to
 * promote: `redundant_call` fires on 0.4% of sessions and earns its place on
 * never being wrong, while the three detectors that led `core` on assumed
 * frequency were the ones removed.
 */
export function detectorsFor(preset: Preset, only?: string[]): Detector[] {
  const wanted = only === undefined ? undefined : new Set(only);
  return allDetectors().filter((d) => {
    if (wanted !== undefined) return wanted.has(d.dimension);
    return PRESET_RANK[d.preset] <= PRESET_RANK[preset];
  });
}

/**
 * What a session cost, exactly as the harness billed it.
 *
 * Populated on 100% of assistant messages across the corpus, and identical in
 * meaning for every language and every tool — it describes the API call, not
 * the work. This is the one place a number needs no interpretation.
 *
 * `cacheRead` is recorded but deliberately **not** turned into a ratio: it
 * re-counts the whole prefix on every call, so it grows with the square of the
 * turn count and `read/(read+creation)` is pinned near 1 by construction
 * (measured p10 0.901 to p90 0.985). `cacheCreation` is what re-ingesting an
 * invalidated prefix actually cost, and it spreads 7.5x p90/p50.
 */
export type TokenTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
};

/** Per-session totals every rate divides by. One pass, never incremental. */
export type Denominators = {
  turnCount: number;
  editCount: number;
  toolCallCount: number;
  /** Tool results the harness itself marked failed. Structural, never inferred. */
  failedCallCount: number;
  /**
   * File-touching calls we could **not** classify as an edit or a read.
   *
   * Reported rather than folded into `editCount`, so the coverage gap is
   * visible instead of silently undercounting. `doctor` surfaces it.
   */
  unclassifiedTouchCount: number;
  tokens: TokenTotals;
};

export function countDenominators(events: Event[]): Denominators {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const d: Denominators = {
    turnCount: 0,
    editCount: 0,
    toolCallCount: 0,
    failedCallCount: 0,
    unclassifiedTouchCount: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  };

  // Files an edit tool already claimed, so a snapshot confirming the same edit
  // does not count it twice.
  //
  // Matched by **path suffix**, not equality: the harness records paths relative
  // to the repo root (`e2e/agents/cursor_cli.go`) while a tool call carries the
  // absolute path (`/Users/[USER]/Projects/devenv/cli/e2e/agents/cursor_cli.go`).
  // Comparing them directly never matches, which silently doubled every edit in
  // a harness-2.1 session — 6 tool edits plus 3 snapshots read as 9.
  const creditedByTool: string[] = [];
  const alreadyCredited = (harnessPath: string): boolean =>
    creditedByTool.some((t) => t === harnessPath || t.endsWith(`/${harnessPath}`));

  for (const e of sorted) {
    if (e.turnType === 'user_prompt') d.turnCount++;

    if (e.tokens !== undefined) {
      d.tokens.input += e.tokens.input ?? 0;
      d.tokens.output += e.tokens.output ?? 0;
      d.tokens.cacheRead += e.tokens.cacheRead ?? 0;
      d.tokens.cacheCreation += e.tokens.cacheCreation ?? 0;
    }

    const evidence = editEvidenceOf(e);
    if (evidence === 'harness') {
      // Tool-agnostic confirmation. Only counts files no edit tool already
      // claimed — otherwise one Edit plus its snapshot would read as two.
      for (const path of e.changedFiles ?? []) {
        if (alreadyCredited(path)) continue;
        d.editCount++;
      }
    }

    if (e.turnType === 'tool_use') {
      d.toolCallCount++;
      if (evidence === 'tool') {
        d.editCount++;
        if (e.filePath !== undefined) creditedByTool.push(e.filePath);
      } else if (evidence === 'probable') {
        // Not an edit for rate purposes — we cannot tell a write from a read.
        d.unclassifiedTouchCount++;
      }
    }

    if (e.turnType === 'tool_result' && callFailed(e)) d.failedCallCount++;
  }

  return d;
}

/**
 * Did the harness say this call failed?
 *
 * Purely structural, and it stays that way. A careful text pattern was tried
 * here and was actively wrong: it read `0 errors, 0 warnings` as a failure, and
 * in 26 of 38 cases where the harness reported a non-zero exit it saw nothing
 * wrong at all. The harness's own verdict is the only one worth having.
 */
export function callFailed(e: Event): boolean {
  if (e.isError === true) return true;
  return e.exitCode !== undefined && e.exitCode !== 0;
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
  const threads = threadsOf(input.events);
  const ordered = [...input.events].sort((a, b) => a.seq - b.seq);

  const candidates: Candidate[] = [];
  const failures: Record<string, number> = {};

  /**
   * Run one detector over one span, isolating its failures.
   *
   * Principle Zero: one detector's bug must not cost the other detectors'
   * findings, nor the remaining spans. Failures are counted and reported — a
   * silent zero would read as "nothing found".
   */
  const evaluate = async (d: Detector, ctx: DetectorContext): Promise<void> => {
    try {
      candidates.push(...(await d.detect(ctx)));
    } catch {
      failures[d.dimension] = (failures[d.dimension] ?? 0) + 1;
    }
  };

  for (const d of detectors) {
    switch (d.scope) {
      case 'window':
        // Only a window-scoped detector gets a skeleton: the others span many
        // windows and must not invent one.
        for (const w of windows) {
          await evaluate(d, { events: w.events, skeleton: w.skeleton, session: input.session });
        }
        break;

      case 'thread':
        for (const threadEvents of threads.values()) {
          await evaluate(d, { events: threadEvents, session: input.session });
        }
        break;

      case 'session':
        await evaluate(d, { events: ordered, session: input.session });
        break;

      case 'project':
        // Declared in the contract so a detector can name its real scope, but
        // unimplemented until the store exists. Refused loudly: evaluating a
        // project-scoped rule over one session would answer a different
        // question than the one it asks.
        throw new Error(
          `${d.dimension} declares project scope, which needs stored history (M3). ` +
            `Remove it from the preset or give it a narrower scope.`,
        );
    }
  }

  return {
    findings: collect(candidates, {
      sessionId: input.session.sessionId,
      project: input.session.project,
      now,
    }),
    denominators: countDenominators(input.events),
    windows: windows.length,
    failures,
  };
}

/**
 * The window a finding's evidence lives in, for `explain`.
 *
 * A thread- or session-scoped finding has no window of its own, but the user
 * still needs to see the turns it is about. The rule: the window containing the
 * finding's **first anchor** — the turn the finding is actually about, rather
 * than wherever its supporting evidence happens to start.
 *
 * **Currently unused.** `explain` does not exist yet; this is the agreed answer
 * to "which skeleton does it show", written down now so the decision is not
 * re-made later. Nothing calls it, which is deliberate rather than an oversight.
 */
export function windowForAnchor(windows: Window[], anchorUuid: string): Window | undefined {
  return windows.find((w) => w.events.some((e) => e.uuid === anchorUuid));
}
