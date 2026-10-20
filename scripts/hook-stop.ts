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
import { dueForJudging, readJudgeState } from '../src/judge-store.ts';
import { resolveCurrentSession } from '../src/read.ts';
import { statSync } from 'node:fs';

function main(): void {
  if (process.env['AGENTSENSEI_DISABLE'] === '1') return;

  const { config } = resolveConfig();
  if (isTripped(readBreaker(config.archive))) return;

  // Independent of the standing freshness window below: the judge has its own
  // cadence, and a fresh standing must not mean a session goes unjudged.
  maybeJudge(config.archive, config.sources);

  // The freshness window is what makes this affordable at every boundary.
  if (isFresh(readStanding(config.archive))) return;

  spawnDetached('compute-standing.ts');
}

/**
 * The live session's judge pass, on a cadence.
 *
 * **Stop fires at every response boundary** — ~788 times in one real session —
 * so this must never be once-per-fire. An invocation costs ~27,000 tokens of
 * overhead before our packet, which at that rate would be indefensible.
 *
 * `dueForJudging` compares bytes rather than counting turns, because the hook
 * has milliseconds and a `stat` is free where a parse is not. Being slightly
 * early or late on the cadence costs nothing.
 */
function maybeJudge(archive: string, sources: string[]): void {
  const state = readJudgeState(archive);
  if (!state.settings.enabled) return;

  const current = resolveCurrentSession(sources);
  if (current === undefined) return;

  let size: number;
  try {
    size = statSync(current.source).size;
  } catch {
    return;
  }
  if (!dueForJudging(state, current.sessionId, size)) return;

  spawnDetached('judge.ts', current.sessionId);
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
