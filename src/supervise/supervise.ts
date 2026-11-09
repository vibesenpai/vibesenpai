/**
 * The entry point any harness calls on any event: look at each job, heal what died, start what is due.
 * Never throws, never waits, never prints.
 */

import { readFileSync, rmSync } from 'node:fs';
import { afterRun } from './backoff.ts';
import { reconcile, type Decision } from './reconcile.ts';
import {
  leaseAgeMs, readLease, readRecord, releaseLease, stderrPath, takeLease, writeLease, writeRecord,
} from './record.ts';
import { LEASE_ENV, type JobSpec } from './types.ts';

export type SuperviseOptions = {
  archive: string;
  now?: number;
  env?: NodeJS.ProcessEnv;
  /** Makes a line from a dead worker's stderr safe to store (e.g. a redactor). */
  clean?: (line: string) => string;
};

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** One pass over every job. Returns what was decided, for tests and `doctor`. */
export function supervise(specs: JobSpec[], opts: SuperviseOptions): Record<string, Decision['kind']> {
  const out: Record<string, Decision['kind']> = {};
  for (const spec of specs) {
    try {
      out[spec.name] = superviseOne(spec, opts);
    } catch {
      out[spec.name] = 'idle';
    }
  }
  return out;
}

function superviseOne(spec: JobSpec, opts: SuperviseOptions): Decision['kind'] {
  const { archive } = opts;
  const now = opts.now ?? Date.now();
  let record = readRecord(archive, spec.name);
  let decision = decide(spec, opts, now, record);

  if (decision.kind === 'reclaim') {
    const tail = lastStderrLine(archive, spec.name);
    const reason = `${decision.why}${tail === '' ? '' : `: ${opts.clean?.(tail) ?? tail}`}`;
    record = afterRun(record, { status: 'failed', kind: 'free', reason }, now);
    writeRecord(archive, spec.name, record);
    releaseLease(archive, spec.name);
    decision = decide(spec, opts, now, record);
  }
  if (decision.kind !== 'start') return decision.kind;

  const lease = takeLease(archive, spec.name, spec.deadlineMs, now);
  if (lease === undefined) return 'running';
  const pid = spec.start({ ...(opts.env ?? process.env), [LEASE_ENV]: lease.token });
  if (pid === undefined) {
    releaseLease(archive, spec.name, lease.token);
    writeRecord(archive, spec.name, afterRun(record, { status: 'failed', kind: 'free', reason: 'could not start' }, now));
    return 'backoff';
  }
  writeLease(archive, spec.name, { ...lease, pid });
  return 'start';
}

function decide(spec: JobSpec, opts: SuperviseOptions, now: number, record = readRecord(opts.archive, spec.name)): Decision {
  const lease = readLease(opts.archive, spec.name);
  const due = (): boolean => {
    try {
      return spec.isDue();
    } catch {
      return false;
    }
  };
  // `isDue` only matters when nothing holds the job, and it can cost a few milliseconds.
  const idle = lease === undefined && leaseAgeMs(opts.archive, spec.name, now) === undefined;
  return reconcile(spec, {
    record,
    lease,
    leaseAgeMs: lease === undefined ? leaseAgeMs(opts.archive, spec.name, now) : undefined,
    due: idle ? due() : false,
    now,
    alive: isAlive,
  });
}

/** The last non-empty line a dead worker printed, then the file is gone. Only startup crashes leave one. */
function lastStderrLine(archive: string, name: string): string {
  try {
    const path = stderrPath(archive, name);
    const lines = readFileSync(path, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l !== '');
    rmSync(path, { force: true });
    // Node ends a crash with its version line; the error itself is the last line naming one.
    const error = [...lines].reverse().find((l) => /error/i.test(l));
    return (error ?? lines.at(-1) ?? '').slice(0, 200);
  } catch {
    return '';
  }
}
