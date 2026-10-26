/**
 * The `Stop` hook: refreshes the standing and starts a judge pass when one is due.
 * It prints nothing (Principle One: the report belongs at session start) and exits 0.
 */

import { runDetached } from '../src/spawn.ts';
import { isTripped, readBreaker } from '../src/breaker.ts';
import { statSync } from 'node:fs';
import { readJudgeState } from '../src/judge/state.ts';
import { dueForJudging, oldestUnread } from '../src/judge/schedule.ts';
import { JUDGE_LOCK_OWNER_ENV, judgeRunning, takeJudgeLock } from '../src/judge/lock.ts';
import { resolveCurrentSession, sessionSizes } from '../src/read.ts';
import { resolveConfig } from '../src/config.ts';
import { isFresh, readStanding } from '../src/standing.ts';

function main(): void {
  if (process.env['AGENTSENSEI_DISABLE'] === '1') return;

  const { config } = resolveConfig();
  if (isTripped(readBreaker(config.archive))) return;

  // Producers spend, readers read: this hook is the only thing that starts a
  // judge pass, so `:session`, `:fix` and `:report` never cost tokens.
  maybeJudge(config.archive, config.sources);

  // The freshness window keeps this to one refresh every ten minutes.
  if (isFresh(readStanding(config.archive))) return;

  spawnDetached('compute-standing.ts');
}


/**
 * Spawn a judge pass if it is enabled, not running, and something is pending.
 * `dueForJudging` compares bytes rather than parsing: a hook has only milliseconds.
 */
function maybeJudge(archive: string, sources: string[]): void {
  const state = readJudgeState(archive);
  if (!state.settings.enabled) return;
  // Cheap pre-check; the real exclusion is `takeJudgeLock` below.
  if (judgeRunning(archive)) return;

  const current = resolveCurrentSession(sources);
  if (current === undefined) return;

  let size: number;
  try {
    size = statSync(current.source).size;
  } catch {
    return;
  }
  // Start a pass if the live session is due OR any backlog is unread. The pass
  // takes no session id, so `judge.ts` batches everything pending into one call.
  const liveDue = dueForJudging(state, current.sessionId, size);
  const backlog = oldestUnread(state, sessionSizes(sources)) !== undefined;
  if (!liveDue && !backlog) return;

  // Atomic: if another hook took the lock first, it owns the pass.
  if (!takeJudgeLock(archive)) return;
  spawnDetached('judge.ts');
}

/** Spawn and forget; the hook never waits. The lock taken here is released by the child as this pid. */
function spawnDetached(script: string, ...args: string[]): void {
  runDetached(script, args, { ...process.env, [JUDGE_LOCK_OWNER_ENV]: String(process.pid) });
}

try {
  main();
} catch {
  // Silent: a hook must exit 0 and must not surface outside session start.
}
process.exit(0);
