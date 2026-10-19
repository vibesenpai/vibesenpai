/**
 * `edit_retry` — an edit the tool refused, then attempted again on the same file.
 *
 * `RULE` · conf `certain` · lower-is-better · core
 *
 * ```
 * Edit  src/api.ts   → is_error, failureKind 'tool'
 * Read  src/api.ts
 * Edit  src/api.ts   → ok
 * ```
 *
 * ── Why this is the first detector built after the reset ────────────────────
 *
 * It needs no text to fire, it is frequent, and it is unambiguous waste. The
 * agent is not reasoning badly — it is fighting the edit tool's exact-match
 * contract, which is the harness being awkward to work in. Measured across
 * 1,139 real sessions: **1,135 of 31,028 edit calls fail (3.6%)**, 917 are
 * retried on the same file, and the read-first reason alone appears in **259
 * sessions (23%)**.
 *
 * ── What the detector reads, and what it does not ──────────────────────────
 *
 * Only structure: the tool's name (a closed four-entry harness list), the
 * harness's own `isError`, its `failureKind` envelope, the file path, and the
 * order the calls happened in. `StructuralEvent` means it *cannot* read the
 * message, so a harness rewording cannot change what fires.
 *
 * ── The false positives this is built around ───────────────────────────────
 *
 * **Only `failureKind: 'tool'` counts.** The other envelopes are not the agent
 * fighting anything, and conflating them would be a product-level error, not
 * just a precision one:
 *
 * ```
 *   1031  tool        the edit tool rejected it     ← this detector
 *     49  denied      the person said no            ← their control, working
 *     41  hook        the person's OWN hook blocked ← their guardrail, working
 *      4  permission  still awaiting a decision
 * ```
 *
 * Reporting a `hook` rejection as waste tells someone their own safety rail is
 * a problem. That is worse than silence.
 *
 * **The retry is what makes it waste.** A single failed edit that the agent
 * correctly abandons is the tool doing its job. Requiring a later edit to the
 * same path is what separates "was stopped" from "kept pushing".
 */

import { EDIT_TOOLS } from '../edits.ts';
import type { Candidate } from '../finding.ts';
import type { StructuralEvent, TurnRef } from '../types.ts';
import type { Detector, DetectorContext } from './types.ts';

/** An edit call we can follow: it names a tool, a path, and a call id. */
type EditCall = { e: StructuralEvent; path: string; callId: string };

function editCallOf(e: StructuralEvent): EditCall | undefined {
  if (e.turnType !== 'tool_use') return undefined;
  if (!EDIT_TOOLS.has(e.toolName ?? '')) return undefined;
  if (e.filePath === undefined || e.toolCallId === undefined) return undefined;
  return { e, path: e.filePath, callId: e.toolCallId };
}

function refOf(e: StructuralEvent): TurnRef {
  return { uuid: e.uuid, sessionId: e.sessionId, seq: e.seq };
}

/**
 * Failed edits that were followed by another edit to the same path.
 *
 * Exported for the probe in `scripts/measure-dimensions.ts`, which must agree
 * with this function rather than approximate it — a detector that disagrees
 * with the measurement justifying it is wrong, and three probes failed exactly
 * that check before the reset.
 */
export function retriedFailures(
  events: StructuralEvent[],
): { path: string; failure: StructuralEvent; retry: StructuralEvent; result: StructuralEvent }[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);

  // Edit calls by id — **every** occurrence, in order, not just the last.
  //
  // A tool-call id is not unique across a transcript: measured on the pinned
  // corpus, one file carries 90 duplicated ids, and 91 results have a same-id
  // call sitting *after* them. Keeping only the last occurrence bound those
  // results to the wrong call, which showed up as evidence listing a verdict at
  // seq 627 for an edit at seq 628 — a result cannot answer a call that has not
  // happened. Found by reading the evidence, not by a test.
  const callsById = new Map<string, EditCall[]>();
  for (const e of sorted) {
    const c = editCallOf(e);
    if (c === undefined) continue;
    const list = callsById.get(c.callId);
    if (list === undefined) callsById.set(c.callId, [c]);
    else list.push(c);
  }

  /** The call this result answered: the nearest one before it with that id. */
  const callAnsweredBy = (result: StructuralEvent): EditCall | undefined => {
    const list = callsById.get(result.toolCallId as string);
    if (list === undefined) return undefined;
    let best: EditCall | undefined;
    for (const c of list) {
      if (c.e.seq >= result.seq) break; // sorted, so nothing later can qualify
      best = c;
    }
    return best;
  };

  const out: { path: string; failure: StructuralEvent; retry: StructuralEvent; result: StructuralEvent }[] = [];

  for (const r of sorted) {
    if (r.turnType !== 'tool_result') continue;
    if (r.isError !== true) continue;
    // The tool refused. Not the person, and not their hook.
    if (r.failureKind !== 'tool') continue;
    if (r.toolCallId === undefined) continue;
    const failed = callAnsweredBy(r);
    if (failed === undefined) continue;

    // A later edit to the same path — later than the *verdict*, not merely
    // than the attempt, so a retry is something the agent did knowing the
    // refusal. Compared exactly: both sides are tool calls carrying the
    // absolute path the tool was given, so the suffix-matching that
    // `countDenominators` needs (tool path vs repo-relative harness path) does
    // not arise here.
    const retry = sorted.find((e) => e.seq > r.seq && editCallOf(e)?.path === failed.path);
    if (retry === undefined) continue;

    out.push({ path: failed.path, failure: failed.e, retry, result: r });
  }

  return out;
}

export function editRetry(): Detector {
  return {
    dimension: 'edit_retry',
    // Session, not thread: a subagent can fail an edit that the main thread
    // then retries, and per-thread neither half would see the other.
    scope: 'session',
    polarity: 'lower-is-better',
    confidence: 'certain',
    method: 'RULE',
    requiresOutcome: false,
    denominator: 'per-edit',
    preset: 'core',

    describe(subject, occurrences) {
      return occurrences === 1
        ? `an edit to ${subject} was refused, then retried`
        : `${occurrences} edits to ${subject} were refused, then retried`;
    },

    async detect(ctx: DetectorContext): Promise<Candidate[]> {
      const bySubject = new Map<string, { evidence: TurnRef[]; anchors: TurnRef[] }>();

      for (const hit of retriedFailures(ctx.events)) {
        const group = bySubject.get(hit.path) ?? { evidence: [], anchors: [] };
        // The attempt, the harness's verdict, and the retry — enough for a
        // person to see what happened without opening the transcript.
        group.evidence.push(refOf(hit.failure), refOf(hit.result), refOf(hit.retry));
        // One anchor per instance, and it is the *result*: it carries the
        // harness's reason, which is what the runner labels the finding from.
        group.anchors.push(refOf(hit.result));
        bySubject.set(hit.path, group);
      }

      return [...bySubject].map(([subject, g]) => ({
        dimension: 'edit_retry',
        subject,
        evidence: g.evidence,
        anchors: g.anchors,
        confidence: 'certain' as const,
        method: 'RULE' as const,
        polarity: 'lower-is-better' as const,
        requiresOutcome: false,
        artifacts: [],
      }));
    },
  };
}
