/** When to judge, what is left to read, and how long that will take. */

import { duration } from '../format.ts';
import type { JudgeState } from './state.ts';

export const BYTES_PER_TURN = 400;

export function dueForJudging(state: JudgeState, sessionId: string, sizeBytes: number): boolean {
  const judged = state.ledger[sessionId] ?? 0;
  return sizeBytes - judged >= state.settings.cadence * BYTES_PER_TURN;
}

/** Seconds per model call, measured at 29-34s over runs of 35 to 195 calls. Two-stage pays it twice. */
export const JUDGE_SECONDS_PER_CALL = 30;

/** Fallback rate: the 30s average read as a half-budget call, erring high so learning lowers the estimate. */
export const FALLBACK_MS_PER_TOKEN = (JUDGE_SECONDS_PER_CALL * 1000) / (60_000 / 2);

/** The work a judge pass still has to do (a ceiling), shared by `now`, `report` and `judge --status`. */
export function pendingWork(
  state: JudgeState,
  sessions: { id: string; sizeBytes: number }[],
): { pending: number; judged: number; unread: number; behind: number; seconds: number } {
  // judged: ledger reached the size; unread: never read; behind: read, then the session grew.
  let unread = 0;
  let behind = 0;
  let judged = 0;
  for (const s of sessions) {
    const at = state.ledger[s.id] ?? 0;
    if (at >= s.sizeBytes) judged += 1;
    else if (at === 0) unread += 1;
    else behind += 1;
  }
  return {
    // Both states have work outstanding, and `seconds` covers both.
    pending: unread + behind,
    judged,
    // Drives the user-facing count: a live session is permanently `behind`, so a count including it never reaches zero.
    unread,
    behind,
    seconds: (unread + behind) * 2 * JUDGE_SECONDS_PER_CALL,
  };
}

/** The session to read next when the live one has nothing new: oldest never-read, not oldest pending. */
export function oldestUnread(
  state: JudgeState,
  sessions: { id: string; sizeBytes: number; mtimeMs?: number }[],
): string | undefined {
  // Skip sessions no packet can hold: their watermark never advances, so they would be picked forever.
  const skipped = new Set(state.skipped ?? []);
  const unread = sessions
    .filter((s) => !skipped.has(s.id) && (state.ledger[s.id] ?? 0) === 0 && s.sizeBytes > 0)
    .sort((a, b) => (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0));
  return unread[0]?.id;
}

/** Model time for the outstanding work, at this machine's measured rate or `FALLBACK_MS_PER_TOKEN`. */
export function estimateQueueSeconds(opts: {
  unread: number;
  queueTokens?: number;
  msPerToken?: number;
  budget?: number;
  concurrency?: number;
}): number {
  const budget = opts.budget ?? 60_000;
  const rate = opts.msPerToken ?? FALLBACK_MS_PER_TOKEN;

  // With no measured sizes, assume one full-budget pass per unread session (an overestimate).
  const tokens = opts.queueTokens ?? opts.unread * budget;
  const CALLS_PER_PASS = 2;
  // Parallel batches, but never more lanes than the queue fills.
  const lanes = Math.max(1, Math.min(opts.concurrency ?? 1, Math.ceil(tokens / budget)));
  return (tokens * rate * CALLS_PER_PASS) / 1000 / lanes;
}

/** The analysis-progress line, in turns rather than minutes except for a pass in flight. */
export function progressLine(
  opts: {
    unread: number;
    /** Total tokens the judge still has to read, measured by the standing pass. */
    queueTokens?: number;
    /** This machine's own rate, where two runs of different sizes exist. */
    msPerToken?: number;
    budget?: number;
    running?: { sessionId?: string; elapsedMs: number };
    callMs?: number;
    /** Spawned but not yet recorded: the spawner writes the marker before the pass writes its run row. */
    spawned?: boolean;
  },
): string {
  const { unread, running } = opts;

  if (running === undefined && opts.spawned === true) return 'Reading a session now.';

  if (running !== undefined) {
    const expected = (opts.callMs ?? JUDGE_SECONDS_PER_CALL * 1000) * 2;
    const left = Math.max(expected - running.elapsedMs, 0);
    // Past the estimate, say so rather than count into the negative.
    const when = left > 0 ? `about ${duration(Math.round(left / 1000))} left` : 'nearly done';
    return `Reading a session now — ${when}.`;
  }

  if (unread === 0) return '';
  return `${unread} session${unread === 1 ? '' : 's'} still to read, all of it in the background when a turn ends.`;
}

/** How far the analysis has got and how much is left, as display lines. */
export function analysisBlock(opts: {
  total: number;
  read: number;
  unread: number;
  running?: { sessionId?: string; elapsedMs: number };
  callMs?: number;
  spawned?: boolean;
  /** Tokens the judge still has to read, measured by the standing pass. */
  queueTokens?: number;
  /** This machine's own ms-per-token, where runs of two sizes exist. */
  msPerToken?: number;
  budget?: number;
  /** Batches a pass sends at once, from the settings. */
  concurrency?: number;
}): string[] {
  const { total, read, unread } = opts;
  if (total === 0) return [];

  const head = `${read} of ${total} session${total === 1 ? '' : 's'} read`;
  if (unread === 0 && opts.running === undefined) {
    return [head, 'Up to date.'];
  }

  const now = progressLine({
    unread,
    ...(opts.running === undefined ? {} : { running: opts.running }),
    ...(opts.callMs === undefined ? {} : { callMs: opts.callMs }),
    ...(opts.spawned === true ? { spawned: true } : {}),
  });

  // Sized by measured packet tokens, not unread x a constant: packets span ~1k to ~66k tokens.
  const left = duration(Math.round(estimateQueueSeconds(opts)));

  return opts.running !== undefined
    ? [head, now]
    : [head, `about ${left} of reading left, in the background from when this turn ends`];
}
