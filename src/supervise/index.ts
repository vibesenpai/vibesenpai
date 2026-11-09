/** The supervisor: any harness calls `supervise` on its events; each worker wraps itself in `runJob`. */

export { supervise } from './supervise.ts';
export { runJob } from './worker.ts';
export { health, releaseHold, type JobHealth } from './health.ts';
export { stderrPath } from './record.ts';
export { type JobSpec, type Outcome } from './types.ts';
