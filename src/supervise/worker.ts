/** The worker's side: claim the lease, heartbeat, end at the deadline, record how it went. */

import { rmSync } from 'node:fs';
import { afterRun } from './backoff.ts';
import { holds, readLease, readRecord, releaseLease, stderrPath, takeLease, writeLease, writeRecord } from './record.ts';
import { LEASE_ENV, type Outcome } from './types.ts';

export type JobContext = {
  /** False once the lease has been reclaimed. Check before anything that spends or writes. */
  holds: () => boolean;
};

export type RunJobOptions = {
  /** Used when run by hand, with no lease handed over. */
  deadlineMs: number;
  /** Run even when another worker holds the lease (safe for jobs that only rewrite their own output). */
  allowConcurrent?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Makes an error message safe to store. */
  clean?: (s: string) => string;
};

const HEARTBEAT_MS = 60_000;

export async function runJob(
  name: string,
  archive: string,
  opts: RunJobOptions,
  fn: (ctx: JobContext) => Promise<Outcome>,
): Promise<Outcome | undefined> {
  // First act: unlink our stderr file, so nothing this process prints later persists unredacted.
  rmSync(stderrPath(archive, name), { force: true });

  const handed = (opts.env ?? process.env)[LEASE_ENV];
  let token: string | undefined;
  if (handed !== undefined && readLease(archive, name)?.token === handed) {
    token = handed;
  } else if (handed === undefined) {
    token = takeLease(archive, name, opts.deadlineMs)?.token;
    if (token === undefined && opts.allowConcurrent !== true) return undefined;
  } else {
    return undefined; // Our lease was reclaimed before we started.
  }

  const stamp = (): void => {
    if (token === undefined) return;
    const l = readLease(archive, name);
    if (l?.token !== token) return;
    const at = new Date().toISOString();
    writeLease(archive, name, { ...l, pid: process.pid, startedAt: l.startedAt ?? at, heartbeatAt: at });
  };
  stamp();
  const beat = setInterval(stamp, HEARTBEAT_MS);
  beat.unref();

  const deadlineAt = token === undefined ? undefined : readLease(archive, name)?.deadlineAt;
  const deadline =
    deadlineAt === undefined
      ? undefined
      : setTimeout(() => {
          finish({ status: 'failed', kind: 'free', reason: 'overran its deadline' });
          process.exit(0);
        }, Math.max(0, Date.parse(deadlineAt) - Date.now()));
  deadline?.unref();

  const ctx: JobContext = { holds: () => token === undefined || holds(archive, name, token) };

  function finish(outcome: Outcome): void {
    if (token === undefined || !holds(archive, name, token)) return; // Reclaimed: the successor owns the record.
    writeRecord(archive, name, afterRun(readRecord(archive, name), outcome, Date.now()));
    releaseLease(archive, name, token);
  }

  let outcome: Outcome;
  try {
    outcome = await fn(ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outcome = { status: 'failed', kind: 'free', reason: (opts.clean?.(msg) ?? msg).slice(0, 200) };
  } finally {
    clearInterval(beat);
    if (deadline !== undefined) clearTimeout(deadline);
  }
  finish(outcome);
  return outcome;
}
