/**
 * What a finding cost, in tokens.
 *
 * ── Tokens, never dollars ──────────────────────────────────────────────────
 *
 * A price table is an allowlist over an open, changing space: it goes silently
 * wrong the week a price moves, and it is meaningless on a subscription. The
 * user put it best — *"how would the users even know what the rates are? Even I
 * don't know what my rates are."* Tokens need no assumption, so tokens is what
 * this reports. Not even behind a configurable rate, because nobody can fill it
 * in.
 *
 * ── Three numbers, never summed ────────────────────────────────────────────
 *
 * They are different things and they price differently:
 *
 *   **written**   arguments the agent generated. Output tokens, and the
 *                 dominant cost — measured across 1,139 sessions, a refused
 *                 edit's discarded `old_string`/`new_string` averages 330
 *                 tokens against 75 for the error text.
 *   **received**  results and error text. The agent did not write these, and
 *                 calling them "written" would be plainly false — for a
 *                 repeated `Read` of a large file they are nearly the whole
 *                 cost.
 *   **carried**   what it cost to keep that text in context afterwards. Real,
 *                 but cache-read priced, so adding it to the others would be
 *                 meaningless arithmetic.
 *
 * ── What prompt caching does to these numbers ──────────────────────────────
 *
 * Measured on real sessions, counted once per response:
 *
 * ```
 *   cache read   818M   98.3%
 *   cache write  14.5M   1.7%
 *   plain input  0.00M   0.00%   <- effectively nothing is uncached
 * ```
 *
 * So once text enters the context it is re-read about **56 times for each time
 * it is written**. Published multipliers, against base input price: a 1-hour
 * cache write is **2x**, a 5-minute write 1.25x, and a read 0.1x. Three
 * consequences, and they decide how these numbers should be read:
 *
 * 1. **`written` is untouched by caching.** Output tokens are output tokens,
 *    and output is a multiple of input — the discarded arguments are the most
 *    expensive per-token part of the waste.
 * 2. **Entering the cache is not free.** Plain input is 0.00% here, so wasted
 *    text does not arrive as ordinary input: it is written into the cache, at
 *    2x base input on a 1-hour TTL. That is *more* than uncached input would
 *    cost. Caching is a premium on entry, amortised by cheap reads, and it
 *    breaks even after two of them.
 * 3. **`carried` is reads, at 0.1x.** With 56 re-reads per write the
 *    amortisation has paid off many times over — caching cut this roughly
 *    tenfold — and yet carried is still the largest component, because a tenth
 *    of fifty-six is five and a half.
 *
 * Which is why the three are reported separately and never added: they are
 * priced differently, and summing them would assert a total nobody is billed.
 *
 * ── Why the cost is recomputed rather than read off the finding ────────────
 *
 * A `Finding` carries `TurnRef`s in transcript order, which is right for a
 * reader and wrong for arithmetic: the triples interleave, and deciding which
 * half of a pair was wasted by its position in a sorted list is exactly the
 * kind of thing that would silently count the retry instead of the failure and
 * double every number. So this asks the detectors' own helpers which calls were
 * wasted — the same functions `scripts/measure-dimensions.ts` uses.
 */

import { estimateTokens } from './skeleton.ts';
import { retriedFailures } from './detect/edit-retry.ts';
import { isRedundant, repeatGroups, subjectOf } from './detect/redundant-call.ts';
import type { Event } from './types.ts';

export type Cost = {
  /** Arguments the agent generated and threw away. Output tokens. */
  written: number;
  /**
   * Results and errors it received for them.
   *
   * Not "input tokens": plain input measures 0.00% of real context traffic, so
   * this text does not arrive as ordinary input — it is written into the cache,
   * at 2x base input on a 1-hour TTL.
   */
  received: number;
  /** Assistant turns the wasted text stayed in context for. */
  carriedTurns: number;
  /** `(written + received) × carriedTurns` — what re-sending it cost. */
  carried: number;
};

export const ZERO: Cost = { written: 0, received: 0, carriedTurns: 0, carried: 0 };

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

/**
 * How many **requests** a piece of text was re-sent on.
 *
 * Requests, not records. Context is re-sent once per API call, and one response
 * is written to the transcript as several records — so counting records inflates
 * this by the average block count, while counting only `assistant_msg` events
 * misses the third of responses that are pure tool calls. Distinct `responseId`
 * over every event is the request count.
 *
 * **Bounded twice, and both bounds matter.** A compaction summarises the text
 * away, so it stops being re-sent — this session compacted at 1,000,333 tokens
 * down to 31,492, twice. And a subagent has its own context, so a main-thread
 * failure is never re-read on a subagent's turns.
 *
 * Without the bounds this number is simply wrong, in the direction that makes
 * the tool look more impressive — which is the direction to be most careful in.
 */
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
    // Any event carrying a response id, not just `assistant_msg`. Measured:
    // 531 of 1,580 responses in one session produce no `assistant_msg` at all
    // — they are pure tool calls — so filtering on that turn type undercounted
    // requests by a third.
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

/**
 * The result a given call received — the nearest one *after* it with that id.
 *
 * **Not a last-wins map keyed on the id.** Tool-call ids are not unique: the
 * pinned corpus has a file reusing 90 of them, and `src/detect/edit-retry.ts`
 * documents the same trap, where a last-wins lookup bound a result to a call
 * that happened afterwards. Here it would price a repeat against some other
 * call's output.
 */
function resultFor(events: Event[], call: Event): Event | undefined {
  if (call.toolCallId === undefined) return undefined;
  for (const e of events) {
    if (e.seq <= call.seq) continue;
    if (e.turnType === 'tool_result' && e.toolCallId === call.toolCallId) return e;
  }
  return undefined;
}

export type CostQuery = {
  dimension: string;
  /** Narrow to one finding's subject. Omitted, it totals the dimension. */
  subject?: string;
  /** Narrow to one harness reason, which is what `fix` recommends against. */
  reason?: string;
};

/**
 * What a dimension cost in this set of events.
 *
 * `reason` exists because `fix` recommends a change for one reason, not a whole
 * dimension: "read before editing" addresses `not-read-first` and leaves
 * `string-not-found` untouched, so quoting the dimension's total beside it
 * would overstate the saving.
 */
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
      // The FAILED attempt, never the retry: the retry is work that had to
      // happen anyway, and counting it would roughly double every figure.
      total = add(total, costOfCall(hit.failure as Event, hit.result as Event, sorted));
    }
    return total;
  }

  if (q.dimension === 'redundant_call') {
    let total = ZERO;
    for (const g of repeatGroups(sorted)) {
      if (!isRedundant(g, sorted)) continue;
      const first = g.calls[0] as Event;
      // Honour the subject. `now` prices one finding at a time, so without this
      // every finding would print the session-wide total — and the subject is
      // built the same way the detector builds it.
      if (q.subject !== undefined && subjectOf(first) !== q.subject) continue;
      // ── Honour the reason too, which this branch did not ─────────────────
      //
      // The `edit_retry` branch above filters on `q.reason`; this one ignored
      // it, and `standing.ts` prices once per **(dimension, reason)** pair. So
      // any `redundant_call` finding that carried a reason was priced at the
      // whole-dimension total and the user saw a figure several times larger
      // than the finding printed beside it.
      //
      // `label()` attaches a reason to any finding whose anchors carry a
      // harness message, so this is not reserved to `edit_retry` by
      // construction — it only looked that way because `reasonOf`'s vocabulary
      // comes from edit refusals. A cost module whose whole justification is
      // "report the measured unit" must not silently report a different one.
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
 * `12345` → `12,000+` — a floor, and the `+` is load-bearing.
 *
 * ── Why these are lower bounds rather than estimates ───────────────────────
 *
 * `estimateTokens` is `ceil(len / 4)`, the usual rule of thumb for prose. It
 * **underestimates** here, measured against real `output_tokens`:
 *
 * ```
 *   responses whose whole content is one tool_use, no thinking, no text
 *   n = 420       est/actual   p10 0.36   p50 0.53   p90 0.67
 * ```
 *
 * So the real figure is about **1.9x** what we compute, and the reason is
 * mundane: JSON tokenises denser than prose — braces, quotes, escaped newlines
 * and indentation each cost a token — so the right divisor for an arguments
 * blob is nearer 2 than 4.
 *
 * **The grouping is what makes this number mean anything.** The first attempt
 * compared one record's `tool_use` against that record's `output_tokens` and
 * got 0.37, then explained the gap as billed-but-unwritten thinking. That was
 * wrong: a response is split across several records which each repeat the same
 * `usage`, so it was comparing one block against the whole response's cost. The
 * figures above group by `responseId` first and keep only responses that are
 * nothing but a single call.
 *
 * A real count needs a tokeniser, and CLAUDE.md forbids network in the shipped
 * analysis path. A 1.9x fudge factor fitted to one machine is not the answer
 * either. So figures round down and say "or more": `11,000+` is true, where
 * `~11,500` would be a point estimate already measured to be low.
 */
export function approx(tokens: number): string {
  if (tokens === 0) return '0';
  if (tokens < 100) return `${tokens}+`;
  const floored = tokens < 10_000 ? Math.floor(tokens / 100) * 100 : Math.floor(tokens / 1000) * 1000;
  return `${floored.toLocaleString('en-US')}+`;
}
