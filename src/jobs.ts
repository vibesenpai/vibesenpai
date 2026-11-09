/**
 * vibesenpai's background jobs, described for the supervisor (`src/supervise/`).
 * Any harness adapter calls `supervise(jobsFor(config, …), …)`; none of this knows which harness it is.
 */

import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { readJudgeState } from './judge/state.ts';
import { dueForJudging, oldestUnread } from './judge/schedule.ts';
import { batchCost, catchUpFrom, eligible, LIMITS_ENV, todayLeft } from './judge/limits.ts';
import { resolveCurrentSession, sessionSizes } from './read.ts';
import { redact } from './redact.ts';
import { runDetached } from './spawn.ts';
import { isFresh, readStanding } from './standing.ts';
import { health, stderrPath, supervise, type JobHealth, type JobSpec } from './supervise/index.ts';

const JOB_NAMES = ['standing', 'judge'] as const;

/** How long the judge may run, and how long a silent one is believed. Also bounds a `run` row's staleness. */
export const JUDGE_DEADLINE_MS = 60 * 60_000;
export const JUDGE_STALE_MS = 5 * 60_000;
export const STANDING_DEADLINE_MS = 15 * 60_000;

const BOOT_GRACE_MS = 60_000;

/** Error text is stored only after redaction. */
export const clean = (s: string): string => redact(s).text;

/** `judge` includes the model pass; `limits` holds it to the daily budget and the catch-up (src/judge/limits.ts). */
export type JobOptions = { judge: boolean; limits?: boolean };

/**
 * The jobs. `judge: false` leaves the model pass out, so a caller that must not spend (the session-start
 * hook, `tick` without `--judge`) still heals and refreshes everything else.
 */
export function jobsFor(config: Pick<Config, 'archive' | 'sources'>, opts: JobOptions): JobSpec[] {
  const limits = opts.limits === true;
  const jobs: JobSpec[] = [
    {
      name: 'standing',
      isDue: () => !isFresh(readStanding(config.archive)),
      start: (env) => runDetached('compute-standing.ts', [], env, stderrPath(config.archive, 'standing')),
      deadlineMs: STANDING_DEADLINE_MS,
      staleMs: JUDGE_STALE_MS,
      bootGraceMs: BOOT_GRACE_MS,
    },
  ];
  if (opts.judge) {
    jobs.push({
      name: 'judge',
      isDue: () => judgeDue(config, limits),
      start: (env) =>
        runDetached('judge.ts', [], limits ? { ...env, [LIMITS_ENV]: '1' } : env, stderrPath(config.archive, 'judge')),
      deadlineMs: JUDGE_DEADLINE_MS,
      staleMs: JUDGE_STALE_MS,
      bootGraceMs: BOOT_GRACE_MS,
    });
  }
  return jobs;
}

/** Enabled, within today's budget, and the live session has grown enough or some session has never been read. */
function judgeDue(config: Pick<Config, 'archive' | 'sources'>, limits: boolean): boolean {
  if (legacyJudgeRunning(config.archive)) return false;
  const state = readJudgeState(config.archive);
  if (!state.settings.enabled) return false;
  // Not enough left for even an empty batch: no worker is spawned just to stop.
  if (limits && (todayLeft(config.archive, state.settings.dailyTokens) ?? 0) < batchCost(0)) return false;
  const current = resolveCurrentSession(config.sources);
  if (current !== undefined) {
    try {
      if (dueForJudging(state, current.sessionId, statSync(current.source).size)) return true;
    } catch {
      // Unreadable live session: the backlog check still applies.
    }
  }
  const sizes = sessionSizes(config.sources);
  return oldestUnread(state, limits ? eligible(state, sizes, catchUpFrom(config.archive, state, sizes, false)) : sizes) !== undefined;
}

/**
 * The lock the previous version used. A pass started by it may still be running during an upgrade,
 * so a fresh one counts as running; a stale one is removed.
 */
function legacyJudgeRunning(archive: string): boolean {
  const dir = join(archive, 'judge.running');
  try {
    if (Date.now() - statSync(dir).mtimeMs < JUDGE_STALE_MS) return true;
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // None.
  }
  return false;
}

/** Remove what the previous version kept that the supervisor replaced. */
function retireLegacy(archive: string): void {
  const breaker = join(archive, 'breaker.json');
  if (existsSync(breaker)) rmSync(breaker, { force: true });
}

/** The one call every harness adapter makes. */
export function superviseAll(
  config: Pick<Config, 'archive' | 'sources'>,
  opts: JobOptions,
): Record<string, string> {
  retireLegacy(config.archive);
  return supervise(jobsFor(config, opts), { archive: config.archive, clean });
}

export function jobsHealth(archive: string): JobHealth[] {
  return health(archive, [...JOB_NAMES]);
}
