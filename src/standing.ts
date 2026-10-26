/**
 * The standing: a rollup of findings across all history, so day one is not blank.
 * Computed by a detached process into `standing.json`; the next session start reads it.
 * A full recompute each time, so last-writer-wins is correct.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { countDenominators, runDetectors, type Detector } from './detect/index.ts';
import { occurrencesOf } from './finding.ts';
import { emptyDismissed, withoutDismissed, type Dismissed } from './dismiss.ts';
import type { OccurrenceRow } from './store.ts';
import { reasonOf } from './detect/labels.ts';
import { costFor } from './cost.ts';
import { sessionStats } from './stats.ts';
import type { Event, Finding } from './types.ts';
import { writeJson } from './files.ts';

const FILE = 'standing.json';
// Bumped (not made optional) so old files are discarded: `readStanding` casts, it does not validate.
const VERSION = 2;

// Do not recompute more often than this; history barely moves between passes.
const MIN_RECOMPUTE_MS = 10 * 60 * 1000;

export type Standing = {
  v: number;
  computedAt: string;
  /** Sessions actually parsed and analysed. */
  sessions: number;
  edits: number;
  tokens: { output: number; cacheCreation: number };
  /** Cache rebuilds across these sessions. Optional so older files still read. */
  rebuilds?: { count: number; tokens: number };
  /** Occurrences and spread per dimension, biggest first. Only the worst subject is kept. */
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
   * Tokens wasted, keyed by reason, because `fix` recommends per reason.
   * No `carried`: summed across sessions it grows with session length, not with waste.
   */
  wastedTokens: Record<string, { written: number; received: number }>;
  /** Sessions found but unreadable, stated rather than silently dropped. */
  unreadable: number;
  /** Rule findings a dismissal kept out of the totals, stated so shrinkage is not misread. */
  dismissed?: number;
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
    writeJson(pathFor(archive), s);
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

/** Running totals, so `gather.ts` can fold in findings it already has. One home for the math. */
type StandingAccumulator = {
  sessions: number;
  edits: number;
  output: number;
  cacheCreation: number;
  rebuildCount: number;
  rebuildTokens: number;
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
    rebuildCount: 0,
    rebuildTokens: 0,
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
  const rebuilds = sessionStats(s.events).rebuilds;
  acc.rebuildCount += rebuilds.count;
  acc.rebuildTokens += rebuilds.tokens;

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
      // Priced once per pair below: `costFor` scans the whole session.
      pairs.add(`${f.dimension}\u0001${reason}`);
    }
  }

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
  opts: { unreadable?: number; now?: string; dismissed?: number } = {},
): Standing {
  return {
    v: VERSION,
    computedAt: opts.now ?? new Date().toISOString(),
    sessions: acc.sessions,
    edits: acc.edits,
    tokens: { output: acc.output, cacheCreation: acc.cacheCreation },
    rebuilds: { count: acc.rebuildCount, tokens: acc.rebuildTokens },
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
    ...(opts.dismissed ? { dismissed: opts.dismissed } : {}),
  };
}

/** Aggregate findings across parsed sessions. Pure: the caller reads, parses and persists. */
export async function computeStanding(
  sessions: SessionInput[],
  detectors: Detector[],
  opts: { unreadable?: number; now?: string; dismissed?: Dismissed } = {},
): Promise<{ standing: Standing; occurrences: OccurrenceRow[] }> {
  const acc = newStandingAccumulator();
  const occurrences: OccurrenceRow[] = [];
  let dismissed = 0;
  for (const s of sessions) {
    const res = await runDetectors({
      events: s.events,
      session: { sessionId: s.sessionId, project: s.project, live: false },
      detectors,
    });
    // Dismissed findings leave the rollup but stay in the rows, so an undo can restore them.
    const shown = withoutDismissed(res.findings, opts.dismissed ?? emptyDismissed());
    dismissed += shown.dismissed;
    accumulateSession(acc, { sessionId: s.sessionId, events: s.events, findings: shown.findings });
    // Rows include every subject (the rollup keeps one). The caller persists them.
    occurrences.push(...occurrencesOf(res.findings));
  }
  return {
    standing: finishStanding(acc, {
      ...(opts.unreadable === undefined ? {} : { unreadable: opts.unreadable }),
      ...(opts.now === undefined ? {} : { now: opts.now }),
      dismissed,
    }),
    occurrences,
  };
}
