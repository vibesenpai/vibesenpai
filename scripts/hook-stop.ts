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

  // ── This hook spends nothing, and that is the whole design ──────────────
  //
  // It used to call `maybeJudge`, which spawned a model pass on a cadence
  // whenever the live session had grown enough. That was defensible only
  // while the judge was off by default — the user had enabled it in an
  // explicit act, so the cadence was something they had asked for.
  //
  // The judge is now on from installation, so the same cadence would mean a
  // detached process spending someone's money at every turn boundary without
  // them asking. That is precisely the Self-Initiated Overreach this tool
  // exists to detect, and shipping it would make the product the thing it
  // criticises.
  //
  // So the trigger moved to the commands: `cmdNow` spawns a pass for the
  // session the user is asking about, when they ask. Nothing here does.
  //
  // What remains is the standing refresh, which is local, free, and the
  // reason the next session can open with a report instead of a spinner.

  // The freshness window is what makes this affordable at every boundary.
  if (isFresh(readStanding(config.archive))) return;

  spawnDetached('compute-standing.ts');
}


/** Spawn and forget. The hook never waits for analysis — see docs/surfaces.md. */
function spawnDetached(script: string, ...args: string[]): void {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', join(import.meta.dirname, script), ...args],
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
