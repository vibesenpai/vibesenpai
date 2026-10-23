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
import { basename, join } from 'node:path';
import { isTripped, readBreaker } from '../src/breaker.ts';
import { statSync } from 'node:fs';
import {
  dueForJudging, judgeRunning, markJudgeRunning, oldestUnread, readJudgeState,
} from '../src/judge-store.ts';
import { discoverTranscripts, resolveCurrentSession } from '../src/read.ts';
import { resolveConfig } from '../src/config.ts';
import { isFresh, readStanding } from '../src/standing.ts';

function main(): void {
  if (process.env['AGENTSENSEI_DISABLE'] === '1') return;

  const { config } = resolveConfig();
  if (isTripped(readBreaker(config.archive))) return;

  // ── This hook is the producer ───────────────────────────────────────────
  //
  // `Stop` fires when the main agent has finished responding — exactly when a
  // turn's work exists to analyse and nothing is waiting on us. That makes it
  // the right trigger, and the commands the wrong one: a command that both
  // shows findings and spends money to make them is two things wearing one
  // name, and the name hides the half that costs.
  //
  // So the split is: **producers write, readers read.** `:session`, `:fix` and
  // `:report` are readers and spend nothing. This spends, on a cadence, in a
  // detached child that prints nothing.
  //
  // It was briefly the other way round — the command spawned and this hook did
  // not — which made `/agentsensei:insights` cost 58k tokens without saying so.
  maybeJudge(config.archive, config.sources);

  // The freshness window is what makes this affordable at every boundary.
  if (isFresh(readStanding(config.archive))) return;

  spawnDetached('compute-standing.ts');
}


/**
 * Spawn a pass for the live session, if it is due.
 *
 * Every gate here is a reason not to spend: the judge is off, the breaker is
 * tripped, a pass is already running, or too little has changed since the last
 * one. `dueForJudging` compares bytes rather than parsing, because this hook
 * has milliseconds and a `stat` is free where a parse is not.
 */
function maybeJudge(archive: string, sources: string[]): void {
  const state = readJudgeState(archive);
  if (!state.settings.enabled) return;
  if (judgeRunning(archive)) return;

  const current = resolveCurrentSession(sources);
  if (current === undefined) return;

  let size: number;
  try {
    size = statSync(current.source).size;
  } catch {
    return;
  }
  // ── When the live session has nothing new, drain the backlog ─────────────
  //
  // This returned here, and that return is why a cold start never caught up.
  // The only automatic spawner is this hook, and it only ever judged the
  // session you are sitting in; the backlog was reachable solely through
  // `judge --backlog --apply`, a CLI command that under D64 nobody types.
  // Measured on a real machine: `pending 25 session(s)`, `judged 0`. Not
  // draining slowly — not draining at all.
  //
  // So an idle turn boundary reads one session nobody has ever looked at.
  // Every gate above still applies — off, already running, breaker tripped —
  // so this adds no new way to spend, only a use for a moment that was
  // already doing nothing.
  const target = dueForJudging(state, current.sessionId, size)
    ? current.sessionId
    : oldestUnread(state, sessionSizes(sources));
  if (target === undefined) return;

  markJudgeRunning(archive);
  spawnDetached('judge.ts', target);
}

/**
 * Every discoverable session with its size, for choosing what to read next.
 *
 * A `statSync` per transcript and nothing parsed: this hook has milliseconds,
 * and the whole reason `dueForJudging` compares bytes is that a stat is free
 * where a parse is not.
 */
function sessionSizes(sources: string[]): { id: string; sizeBytes: number; mtimeMs: number }[] {
  const out: { id: string; sizeBytes: number; mtimeMs: number }[] = [];
  for (const source of discoverTranscripts(sources)) {
    try {
      const st = statSync(source);
      out.push({ id: basename(source, '.jsonl'), sizeBytes: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // A transcript that vanished between listing and stat is simply not a
      // candidate. Principle Zero: never throw out of a hook.
    }
  }
  return out;
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
