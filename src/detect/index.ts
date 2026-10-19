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
import { buildWindows, threadsOf, type SkeletonOptions, type Window } from '../skeleton.ts';
import type { Event, Finding, Preset } from '../types.ts';
import type { Detector, DetectorContext, SessionFacts } from './types.ts';
import { hasSuccessClaim } from './claims.ts';
import type { VerificationLookup } from '../verify.ts';
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
  /**
   * File-touching calls we could **not** classify as an edit or a read.
   *
   * Reported rather than folded into `editCount`, so the coverage gap is
   * visible instead of silently undercounting. `doctor` surfaces it.
   */
  unclassifiedTouchCount: number;
};

/**
 * Claude Code's own read-only tools.
 *
 * Also a closed, published, slow-moving space — and the reason path presence
 * alone cannot mean "edit": `Read` carries a `filePath` too, and so does
 * `mcp__acp__Read`.
 */
export const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);

export type EditEvidence =
  /** A Claude-owned writer. Closed list, authoritative. */
  | 'tool'
  /** The harness recorded the file's version rising. Tool-agnostic. */
  | 'harness'
  /** Carries a path, is not a known reader — probable, not proven. */
  | 'probable';

/**
 * Did a file change, and how do we know?
 *
 * Three layers, strongest first, because no single one covers the world:
 *
 * 1. `tool` — Claude's own edit tools. A legitimate allowlist: closed space,
 *    published by Anthropic, four entries, rarely changes. Covers 789 of 794
 *    file-writing calls measured.
 * 2. `harness` — `file-history-snapshot` version increases. Tool-agnostic, so
 *    it catches MCP writes and tools that do not exist yet. Version-gated
 *    though: absent before harness 2.1.
 * 3. `probable` — carries a path, is not a known reader. Cannot separate an
 *    unknown writer from an unknown reader, so it **demotes** rather than
 *    asserts: counted separately and never treated as a confirmed edit.
 *
 * This is the shape the allowlist rule demands: the closed list is authoritative
 * where it applies, behaviour covers the open remainder, and what neither can
 * decide is reported as undecided rather than guessed.
 */
export function editEvidenceOf(e: Event): EditEvidence | undefined {
  if (e.turnType === 'system' && (e.changedFiles?.length ?? 0) > 0) return 'harness';
  if (e.turnType !== 'tool_use') return undefined;
  const name = e.toolName ?? '';
  if (EDIT_TOOLS.has(name)) return 'tool';
  if (READ_TOOLS.has(name)) return undefined;
  if (e.filePath !== undefined) return 'probable';
  return undefined;
}

/**
 * Claude Code's own file-writing tools.
 *
 * A name allowlist, and a legitimate one: the space is **closed** — Anthropic
 * publishes these, there are four, and they change rarely. That is the test for
 * whether a list is acceptable. It is not the whole answer for "did a file
 * change?" in a world with MCP servers (see `fileTouches`), but it is the
 * authoritative layer, covering 789 of 794 file-writing calls measured.
 *
 * One definition: this previously existed as three separate copies.
 */
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function countDenominators(
  events: Event[],
  verification: VerificationLookup,
): Denominators {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const d: Denominators = {
    turnCount: 0,
    editCount: 0,
    toolCallCount: 0,
    verifiedEditCount: 0,
    successClaimCount: 0,
    unclassifiedTouchCount: 0,
  };

  // An edit is "verified" when a verification command runs after it. Tracked as
  // a pending set rather than a per-edit scan, so one test run can clear every
  // edit that preceded it — which is what actually happened.
  let pendingEdits = 0;

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

    const evidence = editEvidenceOf(e);
    if (evidence === 'harness') {
      // Tool-agnostic confirmation. Only counts files no edit tool already
      // claimed — otherwise one Edit plus its snapshot would read as two.
      for (const path of e.changedFiles ?? []) {
        if (alreadyCredited(path)) continue;
        d.editCount++;
        pendingEdits++;
      }
    }

    if (e.turnType === 'tool_use') {
      d.toolCallCount++;
      if (evidence === 'tool') {
        d.editCount++;
        pendingEdits++;
        if (e.filePath !== undefined) creditedByTool.push(e.filePath);
      } else if (evidence === 'probable') {
        // Not an edit for rate purposes — we cannot tell a write from a read.
        d.unclassifiedTouchCount++;
      } else if (verification.isVerification(e.command)) {
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
    denominators: countDenominators(input.events, input.session.verification),
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
