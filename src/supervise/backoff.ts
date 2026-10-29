/** What a finished run does to a job's record. Pure. */

import type { JobRecord, Outcome } from './types.ts';

/** Waits after consecutive free failures; the last repeats for ever, so a job always comes back. */
export const FREE_BACKOFF_MS = [5, 30, 120, 720, 1440].map((m) => m * 60_000);

/** Paid failures in a row before the job holds. Each one billed a model call. */
export const PAID_HOLD_AFTER = 3;

export function afterRun(r: JobRecord, outcome: Outcome, now: number): JobRecord {
  const at = new Date(now).toISOString();
  if (outcome.status === 'ok') {
    return { failures: 0, paidFailures: 0, lastEnd: { at, status: 'ok' } };
  }
  const failures = r.failures + 1;
  const paidFailures = outcome.kind === 'paid' ? r.paidFailures + 1 : r.paidFailures;
  const wait = FREE_BACKOFF_MS[Math.min(failures, FREE_BACKOFF_MS.length) - 1] as number;
  return {
    failures,
    paidFailures,
    firstFailureAt: r.firstFailureAt ?? at,
    retryAt: new Date(now + wait).toISOString(),
    ...(paidFailures >= PAID_HOLD_AFTER ? { held: true } : {}),
    lastEnd: { at, status: 'failed', kind: outcome.kind, reason: outcome.reason },
  };
}
