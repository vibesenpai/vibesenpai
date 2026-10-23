/**
 * The standing — what your history says, so day one is not blank.
 *
 * ── The problem this solves ────────────────────────────────────────────────
 *
 * The ambient surface only knows about the session it is in, so a fresh install
 * shows nothing until new findings happen. Measured on a real machine:
 * `edit_retry` fires in a third of sessions and `redundant_call` in one in 250,
 * so "nothing yet" could last days — while the answer was already sitting in
 * transcripts on disk.
 *
 * Worse, that history is **perishable**. The harness's own `cleanupPeriodDays`
 * defaults to 30 and we keep no copies by design, so whatever is on disk now is
 * the most there will ever be. Waiting is not neutral; it loses data.
 *
 * ── Fire and forget, then check later ─────────────────────────────────────
 *
 * ```
 * SessionStart → spawn detached, print NOTHING, exit
 *                      ↓ (parses every transcript, ~500ms for 4)
 *                writes standing.json
 * Stop (often)  → notices it, and the statusline renders it
 * ```
 *
 * Nothing is computed in a hook and nothing is printed from one. That last part
 * is a deliberate improvement on the original design, which had `SessionStart`
 * emit the aggregate for the model to relay: this version never puts anything
 * into the agent's context, so the tool cannot perturb the session it measures
 * — not even by ~100 tokens.
 *
 * ── Why a stored file rather than computing on demand ────────────────────
 *
 * Parsing is 95% of the cost and scales with history, so a statusline could
 * never do it. The file is the handoff between a slow producer and a fast
 * reader, exactly like the queue.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { countDenominators, runDetectors, type Detector } from './detect/index.ts';
import { occurrencesOf } from './finding.ts';
import type { OccurrenceRow } from './store.ts';
import { reasonOf } from './detect/labels.ts';
import { costFor } from './cost.ts';
import type { Event, Finding } from './types.ts';

const FILE = 'standing.json';
const MARKER = 'standing.running';
// 2: added `wastedTokens`. Bumped rather than made optional so a v1 file on
// disk is discarded and recomputed — `readStanding` casts rather than
// validates, so an absent field would otherwise read as `undefined` behind a
// type that promises it is there. Consumers still use `?.` for that reason.
const VERSION = 2;

/**
 * How long a run marker is believed.
 *
 * A pass that died leaves its marker behind, and a status bar saying "reading
 * your past sessions" forever would be worse than saying nothing. Past this,
 * the marker is treated as absent — the failure mode is going quiet.
 */
export const MARKER_STALE_MS = 2 * 60 * 1000;

/**
 * Do not recompute more often than this.
 *
 * Opening four windows in a minute should not parse the whole history four
 * times. Generous because the input barely moves: a transcript that grew since
 * the last pass is covered by the live session's own analysis anyway.
 */
export const MIN_RECOMPUTE_MS = 10 * 60 * 1000;

export type Standing = {
  v: number;
  computedAt: string;
  /** Sessions actually parsed and analysed. */
  sessions: number;
  edits: number;
  tokens: { output: number; cacheCreation: number };
  /**
   * Occurrences and spread, per dimension, biggest first.
   *
   * `top` and `files` exist so the report can answer "4 *what* edits?" — the
   * first version named a count with no subject, and the first person to read
   * it asked exactly that. Only the worst subject is kept: storing every one
   * would grow `standing.json` without bound, and the report has room for one.
   */
  dimensions: {
    dimension: string;
    occurrences: number;
    sessions: number;
    /** Distinct subjects, for "across 3 files". */
    files: number;
    /** The subject it happened to most, for "most often X". */
    top?: { subject: string; occurrences: number };
  }[];
  /** The harness's own reasons, summed across every finding. */
  reasons: Record<string, number>;
  /**
   * Tokens wasted, **keyed by reason** rather than by dimension.
   *
   * Per reason because that is the grain `fix` recommends at: "read before
   * editing" addresses `not-read-first` and leaves `string-not-found`
   * untouched, so quoting the dimension's whole total beside it would overstate
   * the saving — on this machine by about 2x.
   *
   * `written` and `received` only. `carried` is deliberately absent: it depends
   * on how long each session ran after the waste, so summing it across sessions
   * produces a number that grows with session length rather than with waste.
   */
  wastedTokens: Record<string, { written: number; received: number }>;
  /**
   * Sessions found but unreadable.
   *
   * Reported rather than dropped: a standing that quietly covered fewer
   * sessions than it claims is the implied-coverage problem the report's depth
   * labelling exists to prevent.
   */
  unreadable: number;
};

function pathFor(archive: string): string {
  return join(archive, FILE);
}

/** Read the standing, or undefined. Never throws. */
export function readStanding(archive: string): Standing | undefined {
  try {
    const raw = JSON.parse(readFileSync(pathFor(archive), 'utf8')) as Partial<Standing>;
    if (raw.v !== VERSION || !Array.isArray(raw.dimensions)) return undefined;
    return raw as Standing;
  } catch {
    return undefined;
  }
}

/** Write it, temp-then-rename. Returns success rather than throwing. */
export function writeStanding(archive: string, s: Standing): boolean {
  try {
    mkdirSync(archive, { recursive: true, mode: 0o700 });
    const tmp = `${pathFor(archive)}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, pathFor(archive));
    return true;
  } catch {
    return false;
  }
}

/** Is the stored standing recent enough to leave alone? */
export function isFresh(s: Standing | undefined, now = Date.now()): boolean {
  if (s === undefined) return false;
  const at = Date.parse(s.computedAt);
  return Number.isFinite(at) && now - at < MIN_RECOMPUTE_MS;
}

export type SessionInput = { sessionId: string; project: string; events: Event[] };

/**
 * Aggregate findings across history.
 *
 * Takes already-parsed sessions so this stays pure and testable — the caller
 * owns reading and parsing, which is also what keeps the expensive part on the
 * detached side of the boundary.
 */
/**
 * The running totals, so a caller that already has a session's findings can
 * fold them in without the events being re-read.
 *
 * **Split out so the math has one home.** `src/gather.ts` runs the detectors
 * itself to build the report, and before this it handed every session's events
 * back for `computeStanding` to run them *again* — holding the whole history in
 * memory for a second pass that produced the same findings. Copying the
 * accumulation into `gather.ts` instead would leave two versions of the
 * standing arithmetic to drift apart.
 */
export type StandingAccumulator = {
  sessions: number;
  edits: number;
  output: number;
  cacheCreation: number;
  perDimension: Map<
    string,
    { occurrences: number; sessions: Set<string>; subjects: Map<string, number> }
  >;
  reasons: Record<string, number>;
  wastedTokens: Record<string, { written: number; received: number }>;
};

export function newStandingAccumulator(): StandingAccumulator {
  return {
    sessions: 0,
    edits: 0,
    output: 0,
    cacheCreation: 0,
    perDimension: new Map(),
    reasons: {},
    wastedTokens: {},
  };
}

/** Fold one session in, while its events are still to hand. */
export function accumulateSession(
  acc: StandingAccumulator,
  s: { sessionId: string; events: Event[]; findings: Finding[] },
): void {
  acc.sessions += 1;
  const d = countDenominators(s.events);
  acc.edits += d.editCount;
  acc.output += d.tokens.output;
  acc.cacheCreation += d.tokens.cacheCreation;

  const pairs = new Set<string>();

  for (const f of s.findings) {
    const slot = acc.perDimension.get(f.dimension) ?? {
      occurrences: 0,
      sessions: new Set<string>(),
      subjects: new Map<string, number>(),
    };
    slot.occurrences += f.occurrences;
    slot.sessions.add(s.sessionId);
    // Summed across sessions: the same file hit in two sessions is one subject
    // with two occurrences, not two subjects.
    slot.subjects.set(f.subject, (slot.subjects.get(f.subject) ?? 0) + f.occurrences);
    acc.perDimension.set(f.dimension, slot);

    for (const [reason, n] of Object.entries<number>(f.reasons ?? {})) {
      acc.reasons[reason] = (acc.reasons[reason] ?? 0) + n;
      // Which (dimension, reason) pairs to price for this session. Collected
      // rather than priced here: `costFor` scans the whole session, so calling
      // it per finding would multiply the cost by the number of findings that
      // share a reason.
      pairs.add(`${f.dimension}\u0001${reason}`);
    }
  }

  // Once per (dimension, reason), after the findings are known.
  for (const pair of pairs) {
    const [dimension, reason] = pair.split('\u0001') as [string, string];
    const c = costFor(s.events, { dimension, reason }, reasonOf);
    const slot = acc.wastedTokens[reason] ?? { written: 0, received: 0 };
    acc.wastedTokens[reason] = {
      written: slot.written + c.written,
      received: slot.received + c.received,
    };
  }
}

/** Close the accumulator into the stored shape. */
export function finishStanding(
  acc: StandingAccumulator,
  opts: { unreadable?: number; now?: string } = {},
): Standing {
  return {
    v: VERSION,
    computedAt: opts.now ?? new Date().toISOString(),
    sessions: acc.sessions,
    edits: acc.edits,
    tokens: { output: acc.output, cacheCreation: acc.cacheCreation },
    dimensions: [...acc.perDimension]
      .map(([dimension, v]) => {
        const ranked = [...v.subjects].sort((a, b) => b[1] - a[1]);
        const first = ranked[0];
        return {
          dimension,
          occurrences: v.occurrences,
          sessions: v.sessions.size,
          files: v.subjects.size,
          ...(first !== undefined ? { top: { subject: first[0], occurrences: first[1] } } : {}),
        };
      })
      .sort((a, b) => b.occurrences - a.occurrences),
    reasons: acc.reasons,
    wastedTokens: acc.wastedTokens,
    unreadable: opts.unreadable ?? 0,
  };
}

export async function computeStanding(
  sessions: SessionInput[],
  detectors: Detector[],
  opts: { unreadable?: number; now?: string } = {},
): Promise<{ standing: Standing; occurrences: OccurrenceRow[] }> {
  const acc = newStandingAccumulator();
  const occurrences: OccurrenceRow[] = [];
  for (const s of sessions) {
    const res = await runDetectors({
      events: s.events,
      session: { sessionId: s.sessionId, project: s.project, live: false },
      detectors,
    });
    accumulateSession(acc, { sessionId: s.sessionId, events: s.events, findings: res.findings });
    // ── Hand the atomic rows back, rather than only the rollup ─────────────
    //
    // This used to return a `Standing` and nothing else, so every rule finding
    // it computed was discarded the moment the rollup was written. The rollup
    // keeps one subject per dimension, which is how a dimension touching three
    // files came to report one. The caller persists these; this function still
    // does no I/O.
    occurrences.push(...occurrencesOf(res.findings));
  }
  return { standing: finishStanding(acc, opts), occurrences };
}

/**
 * One line for the statusline, when the current session has nothing to say.
 *
 * **Past tense, and a count with its denominator.** This is not a nudge about
 * the session you are in — it is the baseline you arrived with, which is why it
 * can sit there without becoming a nag: it makes no claim about now, and it
 * gives the next finding something to be compared against.
 *
 * Empty when there is nothing, including when history is clean. "No findings
 * across 173 edits" is a real result, but it is not worth a permanent line.
 */
export function standingLine(s: Standing | undefined): string {
  if (s === undefined || s.dimensions.length === 0) return '';
  const top = s.dimensions[0] as Standing['dimensions'][number];
  const what =
    top.dimension === 'edit_retry'
      ? `${top.occurrences} edit${top.occurrences === 1 ? '' : 's'} refused then retried`
      : top.dimension === 'redundant_call'
        ? `${top.occurrences} identical call${top.occurrences === 1 ? '' : 's'} repeated`
        : `${top.dimension} ×${top.occurrences}`;
  return `⌁ ${what} in ${s.sessions} past session${s.sessions === 1 ? '' : 's'}`;
}

/**
 * `computedAt` as a local timestamp, for a human reading it.
 *
 * The stored value is UTC because that is what sorts and compares correctly.
 * Printing it raw showed "01:46" to someone whose clock said 18:46 — a number
 * that reads as wrong rather than as a different zone.
 */
export function computedAtLocal(s: Standing): string {
  const t = new Date(s.computedAt);
  if (Number.isNaN(t.getTime())) return s.computedAt;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ` +
    `${pad(t.getHours())}:${pad(t.getMinutes())}`
  );
}

/**
 * Say that a pass has started, so the statusline can tell someone to sit tight.
 *
 * Written by the hook rather than by the pass itself: the hook knows it spawned
 * something, and the pass may not get to run its first line for a moment. The
 * point is that the very first boundary after an install has something friendly
 * to show instead of a blank bar.
 *
 * Never throws — a marker that cannot be written costs a reassuring line.
 */
export function markStarted(archive: string): void {
  try {
    mkdirSync(archive, { recursive: true, mode: 0o700 });
    writeFileSync(join(archive, MARKER), `${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch {
    /* a missing marker is not worth a failure */
  }
}

export function clearStarted(archive: string): void {
  try {
    rmSync(join(archive, MARKER), { force: true });
  } catch {
    /* staleness covers this */
  }
}

/**
 * Is a pass believed to be running right now?
 *
 * Compared on **absolute** distance, which is not fussiness. An earlier version
 * required `now - mtime >= 0` to reject a bogus future timestamp, and that
 * rejected the normal case: a file written and checked in the same millisecond
 * can report an mtime a fraction ahead of `Date.now()`, so the marker read as
 * absent and the friendly line never appeared at all.
 *
 * Absolute distance keeps the guard that matters — a marker from a badly wrong
 * clock still ages out instead of pinning the status bar forever — without
 * failing on sub-millisecond skew.
 */
export function isProcessing(archive: string, now = Date.now()): boolean {
  try {
    return Math.abs(now - statSync(join(archive, MARKER)).mtimeMs) < MARKER_STALE_MS;
  } catch {
    return false;
  }
}

