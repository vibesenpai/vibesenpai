/** Each job's state, as data. Rendering is the caller's: this module knows no surface. */

import { emptyRecord, readLease, readRecord, writeRecord } from './record.ts';
import type { JobRecord } from './types.ts';

export type JobHealth =
  | { job: string; state: 'ok' | 'running' | 'never-ran' }
  | { job: string; state: 'retrying'; failures: number; since: string; reason: string; retryAt: string }
  | { job: string; state: 'held'; paidFailures: number; reason: string };

export function health(archive: string, names: string[]): JobHealth[] {
  return names.map((job) => healthOf(job, readRecord(archive, job), readLease(archive, job) !== undefined));
}

function healthOf(job: string, r: JobRecord, leased: boolean): JobHealth {
  const reason = r.lastEnd?.reason ?? 'reason unknown';
  if (r.held === true) return { job, state: 'held', paidFailures: r.paidFailures, reason };
  if (leased) return { job, state: 'running' };
  if (r.failures > 0 && r.retryAt !== undefined) {
    return { job, state: 'retrying', failures: r.failures, since: r.firstFailureAt ?? r.retryAt, reason, retryAt: r.retryAt };
  }
  return { job, state: r.lastEnd === undefined ? 'never-ran' : 'ok' };
}

/** Clear a hold and the failure count. The only way out of a hold, and always an explicit act. */
export function releaseHold(archive: string, job: string): void {
  writeRecord(archive, job, emptyRecord());
}
