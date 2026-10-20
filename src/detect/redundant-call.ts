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

/**
 * Two is a repeat.
 *
 * **Three was the wrong floor, and measuring said so.** At three the detector
 * found 6 findings in 1,139 sessions — 0.5%, which is close enough to nothing
 * that it was kept out of `core` on precision alone. At two, with edit tools
 * excluded below, it finds 265 across 5.0% of sessions, and the shape of them
 * is unarguable: `git push 2>&1` ten times with byte-identical output,
 * `npx tsc --noEmit | head -30` five times nine seconds apart.
 *
 * Nothing was loosened to get there. The guards that cut 298 raw groups to 9
 * all still apply; only the count changed.
 */
export const DEFAULT_MIN_REPEATS = 2;

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
 * Why an edit tool can never produce one of these findings.
 *
 * **Measured, after the threshold moved to two.** Of 97 edit/write pairs the
 * lower floor newly flagged, **92 made a real change** — the harness's own
 * `structuredPatch` was non-empty — and only 5 changed nothing. Flagging them
 * would have been 95% wrong.
 *
 * The reason is structural rather than bad luck. For every other tool,
 * identical arguments plus identical output means the same question got the
 * same answer. For an edit, the output is the file's *new* contents, so two
 * edits can read identically while the second genuinely changed something —
 * whether it did is in `structuredPatch`, which this parser does not keep.
 *
 * At three repeats the `somethingChangedBetween` guard hid this: the middle
 * call was itself an edit, so the group was dropped before anyone looked. At
 * two there is no middle call and the guard is vacuous. Excluding the tools
 * outright is the honest version of what that guard was accidentally doing,
 * and it costs nothing — at three repeats, no edit-tool finding existed.
 */
export const EXCLUDED_TOOLS = EDIT_TOOLS;

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

  // ── A tool-call id is not unique ─────────────────────────────────────────
  //
  // **Every** occurrence, in order, never just the last. Measured: one pinned
  // fixture reuses 90 ids, and a last-wins map made two different results
  // resolve to the *same* call object — which this detector then counted as
  // that call repeating itself. All 45 findings it produced on the pinned
  // corpus were one event counted twice, and none were genuine.
  //
  // Threshold 3 hid it, because a fake pair needs only one collision. The fix
  // is the one `src/detect/edit-retry.ts` already documents: bind a result to
  // the nearest call *before* it.
  const callsById = new Map<string, StructuralEvent[]>();
  for (const e of sorted) {
    if (e.turnType === 'tool_use' && e.toolCallId !== undefined && e.argHash !== undefined) {
      const list = callsById.get(e.toolCallId);
      if (list === undefined) callsById.set(e.toolCallId, [e]);
      else list.push(e);
    }
  }

  /** The call this result answered: the nearest one before it with that id. */
  const callAnsweredBy = (result: StructuralEvent): StructuralEvent | undefined => {
    const list = callsById.get(result.toolCallId as string);
    if (list === undefined) return undefined;
    let best: StructuralEvent | undefined;
    for (const c of list) {
      if (c.seq >= result.seq) break; // sorted, so nothing later can qualify
      best = c;
    }
    return best;
  };

  const groups = new Map<string, StructuralEvent[]>();
  for (const e of sorted) {
    if (e.turnType !== 'tool_result' || e.toolCallId === undefined) continue;
    // A missing digest is not a match: `outHash` is absent when output was
    // empty or uncapturable, and `unknown` beats guessing.
    if (e.outHash === undefined) continue;
    const call = callAnsweredBy(e);
    if (call === undefined) continue;
    if (POLLING_TOOLS.has(call.toolName ?? '')) continue;
    // An edit's output is the file's new contents, so "the same answer" does
    // not mean "nothing happened". See `EXCLUDED_TOOLS`.
    if (EXCLUDED_TOOLS.has(call.toolName ?? '')) continue;

    const k = keyOf(call, e.outHash);
    const list = groups.get(k);
    if (list === undefined) groups.set(k, [call]);
    else list.push(call);
  }

  const out: RepeatGroup[] = [];
  for (const [key, group] of groups) {
    // **One call per turn, even when two results claim it.** Nearest-preceding
    // binding fixes most of the duplicated-id damage, but a reused id can still
    // point two results at one call — which would then look like that call
    // repeating itself. 40 such pairs survived the binding fix on SWE-chat.
    // A repeat means two *different* turns, so the seq is the identity.
    const bySeq = new Map<number, StructuralEvent>();
    for (const c of group) if (!bySeq.has(c.seq)) bySeq.set(c.seq, c);
    const calls = [...bySeq.values()];
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
