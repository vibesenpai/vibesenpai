/**
 * What a finding cost, in tokens: written (output), received (results), carried (re-sent
 * in context). Never dollars, since prices change and are meaningless on a subscription;
 * never summed, since each is priced differently. The detectors' own helpers pick the
 * wasted calls, so a retry is never counted instead of its failure.
 */

import { estimateTokens } from './skeleton.ts';
import { retriedFailures } from './detect/edit-retry.ts';
import { isRedundant, repeatGroups, subjectOf } from './detect/redundant-call.ts';
import type { Event } from './types.ts';

export type Cost = {
  /** Arguments the agent generated and threw away. Output tokens. */
  written: number;
  /** Results and errors it received for them (cache-written, not plain input). */
  received: number;
  /** Assistant turns the wasted text stayed in context for. */
  carriedTurns: number;
  /** `(written + received) × carriedTurns` — what re-sending it cost. */
  carried: number;
};

const ZERO: Cost = { written: 0, received: 0, carriedTurns: 0, carried: 0 };

function add(a: Cost, b: Cost): Cost {
  return {
    written: a.written + b.written,
    received: a.received + b.received,
    carriedTurns: Math.max(a.carriedTurns, b.carriedTurns),
    carried: a.carried + b.carried,
  };
}

/** The actor an event belongs to. A subagent's context is not the main thread's. */
function actorOf(e: Event): string {
  return e.sidechainId ?? 'main';
}

/** Requests (distinct `responseId`s) the text was re-sent on, up to the next compaction, same actor only. */
export function carriedTurnsAfter(events: Event[], from: Event): number {
  const actor = actorOf(from);
  const compactedAt = events.find(
    (e) => e.systemKind === 'compaction' && e.seq > from.seq && actorOf(e) === actor,
  );
  const limit = compactedAt?.seq ?? Number.POSITIVE_INFINITY;
  const requests = new Set<string>();
  for (const e of events) {
    if (e.seq <= from.seq || e.seq >= limit) continue;
    if (actorOf(e) !== actor) continue;
    // Any event with a response id: about a third of responses are pure tool calls.
    if (e.responseId !== undefined) requests.add(e.responseId);
  }
  return requests.size;
}

/** The cost of one wasted call: what was written for it, and what came back. */
function costOfCall(call: Event, result: Event | undefined, events: Event[]): Cost {
  const written = estimateTokens('x'.repeat(call.argBytes ?? 0));
  const received = estimateTokens('x'.repeat(result?.outBytes ?? 0));
  const turns = carriedTurnsAfter(events, result ?? call);
  return { written, received, carriedTurns: turns, carried: (written + received) * turns };
}

/** The nearest result after the call with its id. Tool-call ids are not unique, so no last-wins map. */
function resultFor(events: Event[], call: Event): Event | undefined {
  if (call.toolCallId === undefined) return undefined;
  for (const e of events) {
    if (e.seq <= call.seq) continue;
    if (e.turnType === 'tool_result' && e.toolCallId === call.toolCallId) return e;
  }
  return undefined;
}

type CostQuery = {
  dimension: string;
  /** Narrow to one finding's subject. Omitted, it totals the dimension. */
  subject?: string;
  /** Narrow to one harness reason, which is what `fix` recommends against. */
  reason?: string;
};

/** What a dimension cost in these events, optionally narrowed to one subject or reason. */
export function costFor(
  events: Event[],
  q: CostQuery,
  reasonOf?: (e: Event) => string | undefined,
): Cost {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);

  if (q.dimension === 'edit_retry') {
    let total = ZERO;
    for (const hit of retriedFailures(sorted)) {
      if (q.subject !== undefined && hit.path !== q.subject) continue;
      if (q.reason !== undefined && reasonOf?.(hit.result as Event) !== q.reason) continue;
      // Price the failed attempt, never the retry, which had to happen anyway.
      total = add(total, costOfCall(hit.failure as Event, hit.result as Event, sorted));
    }
    return total;
  }

  if (q.dimension === 'redundant_call') {
    let total = ZERO;
    for (const g of repeatGroups(sorted)) {
      if (!isRedundant(g, sorted)) continue;
      const first = g.calls[0] as Event;
      // Filter on subject and reason too, or each finding is priced at the dimension total.
      if (q.subject !== undefined && subjectOf(first) !== q.subject) continue;
      for (const call of g.calls.slice(1)) {
        const result = resultFor(sorted, call as Event);
        if (q.reason !== undefined && reasonOf?.(result as Event) !== q.reason) continue;
        total = add(total, costOfCall(call as Event, result, sorted));
      }
    }
    return total;
  }

  return ZERO;
}

/**
 * `12345` -> `12,000+`: a floor, and the `+` is load-bearing.
 * `estimateTokens` (len/4) undercounts JSON arguments about 1.9x, and a real count needs a
 * tokeniser, so figures round down and say "or more" rather than give a point estimate.
 */
export function approx(tokens: number): string {
  if (tokens === 0) return '0';
  if (tokens < 100) return `${tokens}+`;
  const floored = tokens < 10_000 ? Math.floor(tokens / 100) * 100 : Math.floor(tokens / 1000) * 1000;
  return `${floored.toLocaleString('en-US')}+`;
}
