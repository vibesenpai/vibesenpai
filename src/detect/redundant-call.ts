/**
 * `redundant_call` — the same call, the same answer, and nothing changed between.
 *
 * `RULE+T` · conf `certain` (or `high`) · lower-is-better · standard
 *
 * ── Aggregation, not consecutive runs ──────────────────────────────────────
 *
 * An earlier version walked each thread looking for *consecutive* identical
 * calls. That was sound and too narrow: it could not see a call repeated five
 * times across a session with other work in between, and being thread-scoped it
 * could not see two actors making the same call at all.
 *
 * This groups by `toolName | argHash | outHash` across the **whole session**,
 * which is the layer the question belongs at — a call is redundant with respect
 * to a session, not to one actor's slice of it.
 *
 * ── Measured: aggregation alone is 93% wrong ───────────────────────────────
 *
 * Over 1,139 real sessions the raw grouping finds 298 groups. Three guards cut
 * it to 9, and each one is carrying real weight:
 *
 * ```
 *   298  raw groups of 3+ identical calls with identical output
 *  -278  an EDIT happened between first and last   <- re-running after a change
 *  -  7  a USER PROMPT happened between            <- new instruction
 *  -  4  median gap >= 60s                         <- polling
 *  ----
 *     9  findings
 * ```
 *
 * **The edit guard is the big one.** `npm test` → fail → edit → `npm test` →
 * same failure is the agent trying a fix that did not work. That is
 * `fail_fix_fail`, and calling it a redundant call would be wrong about the one
 * thing that matters: whether the repeat was informed.
 */

import { EDIT_TOOLS } from '../edits.ts';
import type { Candidate } from '../finding.ts';
import type { Confidence, StructuralEvent, TurnRef } from '../types.ts';
import type { Detector, DetectorContext } from './types.ts';

export const DEFAULT_MIN_REPEATS = 3;

/**
 * A repeat slower than this is waiting, not looping.
 *
 * **A threshold, and the only one in the detector — so here is where it comes
 * from.** Polling is the false positive aggregation introduces, and it is
 * mostly written as `sleep 60 && <command>`, which a detector may not read.
 * Timestamps are structural, and the two populations separate cleanly on them:
 *
 * ```
 *   72s  sleep 60 && echo "Poll time"          x8
 *   66s  sleep 60 && gh api .../reviews        x9
 *   64s  sleep 60 && gh run view <id>          x4
 *   ----------------------------------------------- 60s
 *   17s  go generate                           x3
 *    9s  npx tsc --noEmit | head -30           x5
 *    4s  Grep, same file                       x3
 *    2s  Read, same file                       x3
 * ```
 *
 * The polls cluster above because `sleep 60` is the idiom; real repeats are
 * seconds apart. Measured on the median gap, not the mean, so one long pause in
 * an otherwise tight run does not excuse it.
 */
export const POLL_GAP_SECONDS = 60;

/**
 * Tools whose whole purpose is to report current state.
 *
 * Kept even though the gap rule catches most polling: `BashOutput` on a
 * finished job can return instantly and identically, so the name is the only
 * thing separating it from a loop. Closed and harness-owned, which is the kind
 * of list D31 permits.
 */
export const POLLING_TOOLS = new Set(['BashOutput', 'TaskOutput', 'Monitor', 'ListAgents']);

/** What makes two calls the same call *and* the same answer. */
function keyOf(call: StructuralEvent, outHash: string): string {
  return `${call.toolName ?? 'unknown'}|${call.argHash ?? ''}|${outHash}`;
}

export type RepeatGroup = {
  key: string;
  calls: StructuralEvent[];
  /** Median seconds between consecutive calls, or undefined when untimed. */
  medianGap?: number;
  /** Any call in the group clipped its own output before we saw it. */
  truncated: boolean;
};

/** Median, which is what a single long pause must not move. */
function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Group a session's calls by identity *and* answer.
 *
 * Exported so `scripts/measure-dimensions.ts` drives the detector's own logic
 * rather than a lookalike — a probe looser than its detector hides exactly the
 * disagreement worth knowing about.
 */
export function repeatGroups(events: StructuralEvent[]): RepeatGroup[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);

  // A result names the call it answered, so identity can include the answer.
  const callById = new Map<string, StructuralEvent>();
  for (const e of sorted) {
    if (e.turnType === 'tool_use' && e.toolCallId !== undefined && e.argHash !== undefined) {
      callById.set(e.toolCallId, e);
    }
  }

  const groups = new Map<string, StructuralEvent[]>();
  for (const e of sorted) {
    if (e.turnType !== 'tool_result' || e.toolCallId === undefined) continue;
    // A missing digest is not a match: `outHash` is absent when output was
    // empty or uncapturable, and `unknown` beats guessing.
    if (e.outHash === undefined) continue;
    const call = callById.get(e.toolCallId);
    if (call === undefined) continue;
    if (POLLING_TOOLS.has(call.toolName ?? '')) continue;

    const k = keyOf(call, e.outHash);
    const list = groups.get(k);
    if (list === undefined) groups.set(k, [call]);
    else list.push(call);
  }

  const out: RepeatGroup[] = [];
  for (const [key, calls] of groups) {
    if (calls.length < 2) continue;
    calls.sort((a, b) => a.seq - b.seq);
    const gaps: number[] = [];
    for (let i = 1; i < calls.length; i++) {
      const a = Date.parse((calls[i - 1] as StructuralEvent).ts ?? '');
      const b = Date.parse((calls[i] as StructuralEvent).ts ?? '');
      if (Number.isFinite(a) && Number.isFinite(b)) gaps.push((b - a) / 1000);
    }
    const gap = median(gaps);
    out.push({
      key,
      calls,
      ...(gap !== undefined ? { medianGap: gap } : {}),
      truncated: calls.some((c) => c.truncatesOwnOutput === true),
    });
  }
  return out;
}

/**
 * Did anything happen between the first and last call that justifies a repeat?
 *
 * An **edit** means state changed, so re-running is informed — that is the
 * `fail_fix_fail` shape and it accounts for 278 of 298 raw groups. A **user
 * prompt** is a new instruction, so whatever follows belongs to it.
 */
export function somethingChangedBetween(
  events: StructuralEvent[],
  from: number,
  to: number,
): boolean {
  return events.some((e) => {
    if (e.seq <= from || e.seq >= to) return false;
    if (e.turnType === 'user_prompt') return true;
    return e.turnType === 'tool_use' && EDIT_TOOLS.has(e.toolName ?? '');
  });
}

/** Is this group a genuine repeat rather than a wait or an informed retry? */
export function isRedundant(
  g: RepeatGroup,
  events: StructuralEvent[],
  minRepeats = DEFAULT_MIN_REPEATS,
): boolean {
  if (g.calls.length < minRepeats) return false;
  const first = g.calls[0] as StructuralEvent;
  const last = g.calls[g.calls.length - 1] as StructuralEvent;
  if (somethingChangedBetween(events, first.seq, last.seq)) return false;
  if (g.medianGap !== undefined && g.medianGap >= POLL_GAP_SECONDS) return false;
  return true;
}

export type RedundantCallOptions = { minRepeats?: number };

export function redundantCall(opts: RedundantCallOptions = {}): Detector {
  const minRepeats = opts.minRepeats ?? DEFAULT_MIN_REPEATS;

  return {
    dimension: 'redundant_call',
    // Session, not thread. A call is redundant with respect to the session —
    // and two actors making the same call is a question only this scope can
    // ask. Aggregation needs no ordering, so interleaving costs nothing.
    scope: 'session',
    polarity: 'lower-is-better',
    confidence: 'certain',
    method: 'RULE+T',
    requiresOutcome: false,
    denominator: 'per-tool-call',
    preset: 'standard',

    describe(subject, occurrences) {
      return `${subject} ran ${occurrences}× with the same answer and nothing changed between`;
    },

    async detect(ctx: DetectorContext): Promise<Candidate[]> {
      const out: Candidate[] = [];

      for (const g of repeatGroups(ctx.events)) {
        if (!isRedundant(g, ctx.events, minRepeats)) continue;

        // A clipped output means the digest compared a prefix, so "the same
        // answer" is a weaker claim. Downgraded, never dropped: the structural
        // facts all still hold.
        const confidence: Confidence = g.truncated ? 'high' : 'certain';

        const evidence: TurnRef[] = g.calls.map((e) => ({
          uuid: e.uuid,
          sessionId: e.sessionId,
          seq: e.seq,
        }));

        out.push({
          dimension: 'redundant_call',
          subject: subjectOf(g.calls[0] as StructuralEvent),
          evidence,
          confidence,
          method: 'RULE+T',
          polarity: 'lower-is-better',
          requiresOutcome: false,
          artifacts: [],
        });
      }

      return out;
    },
  };
}

/**
 * How the repeated call is named.
 *
 * The digest is identity, not language, and a detector cannot read the command
 * — so where no readable target exists the subject is the tool plus a short
 * digest. `src/render.ts` substitutes the command at display time, where
 * reading it is allowed.
 */
export function subjectOf(e: StructuralEvent): string {
  const tool = e.toolName ?? 'unknown';
  if (e.filePath !== undefined && e.filePath.trim() !== '') return `${tool} ${e.filePath}`;
  return `${tool} #${(e.argHash ?? '').slice(0, 6)}`;
}
