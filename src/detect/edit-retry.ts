/**
 * `edit_retry`: an edit the tool refused, then attempted again on the same file.
 * `RULE` · conf `certain` · lower-is-better · core
 *
 * Only `failureKind: 'tool'` counts: a denial or the person's own hook is their control working, not waste.
 * The retry is what makes it waste; an abandoned failed edit is the tool doing its job.
 */

import { EDIT_TOOLS } from './tools.ts';
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
 * Failed edits followed by another edit to the same path.
 * Exported so `scripts/measure-dimensions.ts` measures with this exact function.
 */
export function retriedFailures(
  events: StructuralEvent[],
): { path: string; failure: StructuralEvent; retry: StructuralEvent; result: StructuralEvent }[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);

  // Every call per id, in order: tool-call ids are not unique within a transcript.
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

    // The next user prompt ends the attempt.
    const nextPrompt = sorted.find((e) => e.turnType === 'user_prompt' && e.seq > r.seq);
    const horizon = nextPrompt?.seq ?? Number.POSITIVE_INFINITY;

    // The next edit to the same path after the verdict, matched exactly (both are absolute tool paths).
    // No N-turn cap: the span ends at the next user prompt (.claude/rules/detectors.md).
    const retry = sorted.find(
      (e) => e.seq > r.seq && e.seq < horizon && editCallOf(e)?.path === failed.path,
    );
    if (retry === undefined) continue;

    out.push({ path: failed.path, failure: failed.e, retry, result: r });
  }

  return out;
}

export function editRetry(): Detector {
  return {
    dimension: 'edit_retry',
    // Session, not thread: a subagent's failed edit may be retried by the main thread.
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
        // The attempt, the verdict, and the retry.
        group.evidence.push(refOf(hit.failure), refOf(hit.result), refOf(hit.retry));
        // Anchor on the result: it carries the reason the runner labels from.
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
      }));
    },
  };
}
