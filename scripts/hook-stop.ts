/**
 * The `Stop` hook. Keeps the standing fresh, and nothing else.
 *
 * ── What it no longer does ─────────────────────────────────────────────────
 *
 * It used to drain a queue for the statusline. The statusline is gone — it cost
 * a permanent row of screen to say one rarely-changing thing, and **no official
 * plugin ships one**, so the queue went with it. What remains is the part that
 * was always load-bearing: making sure the next session's report is current.
 *
 * ── It prints nothing, and that is deliberate ──────────────────────────────
 *
 * A `Stop` hook could emit `systemMessage` and show something after every
 * response. That would be a notification on every turn, which is the
 * interrupting surface Principle One forbids. The report belongs at session
 * start, where there is no work in progress to interrupt.
 *
 * ── Principle Zero ─────────────────────────────────────────────────────────
 *
 * `AGENTSENSEI_DISABLE=1` short-circuits on line one. The refresh is detached
 * and unwaited, guarded by the circuit breaker and by the standing's own
 * freshness window — so it runs at most once every ten minutes rather than on
 * every boundary. Exits 0 unconditionally.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { isTripped, readBreaker } from '../src/breaker.ts';
import { resolveConfig } from '../src/config.ts';
import { isFresh, readStanding } from '../src/standing.ts';

function main(): void {
  if (process.env['AGENTSENSEI_DISABLE'] === '1') return;

  const { config } = resolveConfig();
  if (isTripped(readBreaker(config.archive))) return;
  // The freshness window is what makes this affordable at every boundary.
  if (isFresh(readStanding(config.archive))) return;

  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', join(import.meta.dirname, 'compute-standing.ts')],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
}

try {
  main();
} catch {
  // Silence. A hook reporting its own failure would be surfacing through a
  // channel this design reserves for the session-start report.
}
process.exit(0);
