/** The supervisor's vocabulary. Harness-agnostic: nothing here knows about hooks, plugins or our passes. */

/** Free failures retry on a back-off; paid ones stop after a few, so a deterministic fault cannot bill on a loop. */
type FailureKind = 'free' | 'paid';

export type JobSpec = {
  name: string;
  /** Is there work? Must be cheap: it runs on every hook. */
  isDue: () => boolean;
  /** Start the worker detached. `env` carries the lease token; return the child's pid if known. */
  start: (env: NodeJS.ProcessEnv) => number | undefined;
  /** The worker ends itself at this age. */
  deadlineMs: number;
  /** A heartbeat older than this, from a dead process, means the worker died. */
  staleMs: number;
  /** A worker that has not claimed its lease within this, and whose process is gone, never started. */
  bootGraceMs: number;
};

/** Who holds a job right now. Lives in `<archive>/jobs/<name>.lease/lease.json`. */
export type Lease = {
  token: string;
  pid?: number;
  spawnedAt: string;
  startedAt?: string;
  heartbeatAt?: string;
  deadlineAt: string;
};

/** How a job has been doing. Lives in `<archive>/jobs/<name>.json`. */
export type JobRecord = {
  failures: number;
  paidFailures: number;
  firstFailureAt?: string;
  retryAt?: string;
  /** Stopped after repeated paid failures; only an explicit act releases it. */
  held?: boolean;
  lastEnd?: { at: string; status: 'ok' | 'failed'; kind?: FailureKind; reason?: string };
};

export type Outcome = { status: 'ok' } | { status: 'failed'; kind: FailureKind; reason: string };

/** The env var that hands a lease token from the spawner to the worker. */
export const LEASE_ENV = 'VIBESENPAI_LEASE';
