/** Desired state against actual state: what one hook event should do about one job. Pure. */

import type { JobRecord, JobSpec, Lease } from './types.ts';

type ReclaimKind = 'never-started' | 'died' | 'overran';

export type Decision =
  | { kind: 'running' }
  | { kind: 'reclaim'; why: ReclaimKind }
  | { kind: 'held' }
  | { kind: 'backoff' }
  | { kind: 'start' }
  | { kind: 'idle' };

export type Observed = {
  record: JobRecord;
  lease: Lease | undefined;
  /** Age of the lease directory when its file is missing or torn. */
  leaseAgeMs: number | undefined;
  due: boolean;
  now: number;
  /** Is this pid still a live process? Injected so the decision stays pure. */
  alive: (pid: number) => boolean;
};

/** A live process is never reclaimed on time alone (a laptop that slept), until twice its deadline. */
const HARD_LIMIT = 2;

export function reconcile(spec: Pick<JobSpec, 'deadlineMs' | 'staleMs' | 'bootGraceMs'>, o: Observed): Decision {
  if (o.lease !== undefined) return judgeLease(spec, o.lease, o);
  // A lease directory with no readable file: a take that crashed between mkdir and write.
  if (o.leaseAgeMs !== undefined) {
    return o.leaseAgeMs > spec.bootGraceMs ? { kind: 'reclaim', why: 'never-started' } : { kind: 'running' };
  }
  if (o.record.held === true) return { kind: 'held' };
  if (o.record.retryAt !== undefined && o.now < Date.parse(o.record.retryAt)) return { kind: 'backoff' };
  return o.due ? { kind: 'start' } : { kind: 'idle' };
}

function judgeLease(spec: Pick<JobSpec, 'deadlineMs' | 'staleMs' | 'bootGraceMs'>, l: Lease, o: Observed): Decision {
  const sinceSpawn = o.now - Date.parse(l.spawnedAt);
  const why: ReclaimKind =
    l.startedAt === undefined ? 'never-started' : o.now > Date.parse(l.deadlineAt) ? 'overran' : 'died';

  // A known pid answers directly: dead means reclaim now; alive means running, unless absurdly old.
  if (l.pid !== undefined) {
    if (!o.alive(l.pid)) return { kind: 'reclaim', why };
    return sinceSpawn > spec.deadlineMs * HARD_LIMIT ? { kind: 'reclaim', why: 'overran' } : { kind: 'running' };
  }
  // No pid: judge by time alone.
  if (l.startedAt === undefined) {
    return sinceSpawn > spec.bootGraceMs ? { kind: 'reclaim', why } : { kind: 'running' };
  }
  const beat = Date.parse(l.heartbeatAt ?? l.startedAt);
  return o.now - beat > spec.staleMs || o.now > Date.parse(l.deadlineAt) ? { kind: 'reclaim', why } : { kind: 'running' };
}
