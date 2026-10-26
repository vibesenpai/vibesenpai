/**
 * `redundant_call`: the same call, the same answer, and nothing changed between.
 * Groups by `toolName | argHash | outHash` across the session; guards and numbers in docs/dimensions.md.
 */

import { EDIT_TOOLS } from './tools.ts';
import type { Candidate } from '../finding.ts';
import type { Confidence, StructuralEvent, TurnRef } from '../types.ts';
import type { Detector, DetectorContext } from './types.ts';

// Two is a repeat. Edit tools are excluded below, which is what keeps two precise.
const DEFAULT_MIN_REPEATS = 2;

// A median gap at or above this is polling (`sleep 60 && …`), not looping. Real repeats are seconds apart.
const POLL_GAP_SECONDS = 60;

// An edit's output is the file's new contents, so identical output does not mean nothing changed.
// Whether it did is in `structuredPatch`, which the parser does not keep.
const EXCLUDED_TOOLS = EDIT_TOOLS;

// `| head`-style truncation is flagged by the parser (`truncatesOwnOutput`) and downgrades to `high`;
// other ways to clip a stream are deliberately not chased.

// Tools that report current state. `BashOutput` on a finished job can return instantly and identically.
const POLLING_TOOLS = new Set(['BashOutput', 'TaskOutput', 'Monitor', 'ListAgents']);

/** What makes two calls the same call *and* the same answer. */
function keyOf(call: StructuralEvent, outHash: string): string {
  return `${call.toolName ?? 'unknown'}|${call.argHash ?? ''}|${outHash}`;
}

type RepeatGroup = {
  key: string;
  calls: StructuralEvent[];
  /** Median seconds between consecutive calls, or undefined when untimed. */
  medianGap?: number;
  /** Any call in the group clipped its own output before we saw it. */
  truncated: boolean;
};

/** Median, so one long pause cannot excuse a tight run. */
function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Group a session's calls by identity and answer. Exported so measurement runs this exact logic. */
export function repeatGroups(events: StructuralEvent[]): RepeatGroup[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);

  // Tool-call ids are not unique: keep every call per id and bind a result to the nearest one before it.
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
    // A missing digest (empty or uncapturable output) is never a match.
    if (e.outHash === undefined) continue;
    const call = callAnsweredBy(e);
    if (call === undefined) continue;
    if (POLLING_TOOLS.has(call.toolName ?? '')) continue;
    if (EXCLUDED_TOOLS.has(call.toolName ?? '')) continue;

    const k = keyOf(call, e.outHash);
    const list = groups.get(k);
    if (list === undefined) groups.set(k, [call]);
    else list.push(call);
  }

  const out: RepeatGroup[] = [];
  for (const [key, group] of groups) {
    // A reused id can still point two results at one call; a repeat needs two different turns.
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

/** An edit or a user prompt between first and last call makes the repeat informed. */
function somethingChangedBetween(
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

type RedundantCallOptions = { minRepeats?: number };

export function redundantCall(opts: RedundantCallOptions = {}): Detector {
  const minRepeats = opts.minRepeats ?? DEFAULT_MIN_REPEATS;

  return {
    dimension: 'redundant_call',
    // Session scope: a call is redundant across actors, not within one thread.
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

        // Clipped output means the digest compared a prefix: downgraded, never dropped.
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
        });
      }

      return out;
    },
  };
}

// Tool plus path, else tool plus a short digest. `src/render.ts` substitutes the command for display.
export function subjectOf(e: StructuralEvent): string {
  const tool = e.toolName ?? 'unknown';
  if (e.filePath !== undefined && e.filePath.trim() !== '') return `${tool} ${e.filePath}`;
  return `${tool} #${(e.argHash ?? '').slice(0, 6)}`;
}
