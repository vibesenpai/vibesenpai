/**
 * The detector registry and the runner. Detectors see `StructuralEvent`s only; the runner attaches
 * harness labels afterwards (.claude/rules/detectors.md). Denominators are per-session,
 * computed here once. One detector throwing never loses the others' findings (Principle Zero).
 */

import { collect, type Candidate } from '../finding.ts';
import { buildWindows, threadsOf, type SkeletonOptions } from '../skeleton.ts';
import type { Event, Finding, Preset } from '../types.ts';
import type { Detector, DetectorContext, SessionFacts } from './types.ts';
import { editEvidenceOf } from './tools.ts';
import { oncePerResponse } from '../normalise.ts';
import { editRetry } from './edit-retry.ts';
import { redundantCall } from './redundant-call.ts';
import { reasonOf } from './labels.ts';

export type { Detector } from './types.ts';
export { EDIT_TOOLS, editEvidenceOf } from './tools.ts';

/** All detectors. Why only these two: GRAVEYARD.md and docs/dimensions.md. */
export function allDetectors(): Detector[] {
  return [editRetry(), redundantCall()];
}

const PRESET_RANK: Record<Preset, number> = { core: 0, standard: 1, all: 2 };

/**
 * Which detectors a preset runs. `core` admits only `certain`/`high` rule dimensions;
 * frequency is not a reason to promote.
 */
export function detectorsFor(preset: Preset, only?: string[], mute?: string[]): Detector[] {
  const wanted = only === undefined ? undefined : new Set(only);
  const silenced = new Set(mute ?? []);
  return allDetectors().filter((d) => {
    // Muting wins over everything, including an explicit `only`.
    if (silenced.has(d.dimension)) return false;
    if (wanted !== undefined) return wanted.has(d.dimension);
    return PRESET_RANK[d.preset] <= PRESET_RANK[preset];
  });
}

/** Mute entries that name no dimension, reported so a typo does not silently mute nothing. */
export function unknownDimensions(names: string[]): string[] {
  const known = new Set(allDetectors().map((d) => d.dimension));
  return names.filter((n) => !known.has(n));
}

/**
 * What a session cost, exactly as the harness billed it.
 * `cacheRead` is never made a ratio: it re-counts the whole prefix per call (DECISIONS.md D49).
 */
type TokenTotals = {
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
  /** File-touching calls classified as neither edit nor read; kept visible, surfaced by `doctor`. */
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

  // Tokens count once per API response (`oncePerResponse`), over events that carry usage.
  // Keyed by event, not uuid: uuids are not unique either.
  const countOnce = new Set(oncePerResponse(sorted.filter((e) => e.tokens !== undefined)));

  // Files an edit tool already claimed, so its snapshot is not counted twice. Matched by path
  // suffix: snapshots carry repo-relative paths, tool calls absolute ones.
  const creditedByTool: string[] = [];
  const alreadyCredited = (harnessPath: string): boolean =>
    creditedByTool.some((t) => t === harnessPath || t.endsWith(`/${harnessPath}`));

  for (const e of sorted) {
    if (e.turnType === 'user_prompt') d.turnCount++;

    if (e.tokens !== undefined && countOnce.has(e)) {
      d.tokens.input += e.tokens.input ?? 0;
      d.tokens.output += e.tokens.output ?? 0;
      d.tokens.cacheRead += e.tokens.cacheRead ?? 0;
      d.tokens.cacheCreation += e.tokens.cacheCreation ?? 0;
    }

    const evidence = editEvidenceOf(e);
    if (evidence === 'harness') {
      // Only files no edit tool already claimed.
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

/** Did the harness say this call failed? Structural only; text patterns were tried and were wrong. */
export function callFailed(e: Event): boolean {
  if (e.isError === true) return true;
  return e.exitCode !== undefined && e.exitCode !== 0;
}

type RunInput = {
  events: Event[];
  session: SessionFacts;
  detectors?: Detector[];
  skeleton?: SkeletonOptions;
  now?: string;
};

type RunResult = {
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

  /** Run one detector over one span; a throw is counted, never swallowed or propagated. */
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
        // Only a window-scoped detector gets a skeleton.
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
        // Refused until stored history exists (M3): one session cannot answer a project question.
        throw new Error(
          `${d.dimension} declares project scope, which needs stored history (M3). ` +
            `Remove it from the preset or give it a narrower scope.`,
        );
    }
  }

  const findings = collect(candidates, {
    sessionId: input.session.sessionId,
    project: input.session.project,
    now,
  });

  return {
    findings: findings.map((f) => label(f, ordered)),
    denominators: countDenominators(input.events),
    windows: windows.length,
    failures,
  };
}

/**
 * Attach the harness's own reasons to a finding that already exists; losing a label never loses
 * the finding. Tallied per anchor, so it sums to `occurrences`.
 */
function label(f: Finding, events: Event[]): Finding {
  const byUuid = new Map(events.map((e) => [e.uuid, e]));
  const reasons: Record<string, number> = {};
  for (const a of f.anchors) {
    const e = byUuid.get(a.uuid);
    if (e === undefined) continue;
    const r = reasonOf(e);
    if (r === undefined) continue;
    reasons[r] = (reasons[r] ?? 0) + 1;
  }
  return Object.keys(reasons).length === 0 ? f : { ...f, reasons };
}
