/** The supervisor: any harness calls `supervise` on its events; each worker wraps itself in `runJob`. */

export { supervise, isAlive, type SuperviseOptions } from './supervise.ts';
export { runJob, type JobContext, type RunJobOptions } from './worker.ts';
export { health, releaseHold, type JobHealth } from './health.ts';
export { stderrPath } from './record.ts';
export { LEASE_ENV, type FailureKind, type JobSpec, type Outcome } from './types.ts';
