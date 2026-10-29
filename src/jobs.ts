/**
 * agentsensei's background jobs, described for the supervisor (`src/supervise/`).
 * Any harness adapter calls `supervise(jobsFor(config, …), …)`; none of this knows which harness it is.
 */

import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { readJudgeState } from './judge/state.ts';
import { dueForJudging, oldestUnread } from './judge/schedule.ts';
import { resolveCurrentSession, sessionSizes } from './read.ts';
import { redact } from './redact.ts';
import { runDetached } from './spawn.ts';
import { isFresh, readStanding } from './standing.ts';
import { health, stderrPath, supervise, type JobHealth, type JobSpec } from './supervise/index.ts';

export const JOB_NAMES = ['standing', 'judge'] as const;

/** How long the judge may run, and how long a silent one is believed. Also bounds a `run` row's staleness. */
export const JUDGE_DEADLINE_MS = 60 * 60_000;
export const JUDGE_STALE_MS = 5 * 60_000;
export const STANDING_DEADLINE_MS = 15 * 60_000;

const BOOT_GRACE_MS = 60_000;

/** Error text is stored only after redaction. */
export const clean = (s: string): string => redact(s).text;

/**
 * The jobs. `judge: false` leaves the model pass out, so a caller that must not spend (the session-start
 * hook, `tick` without `--judge`) still heals and refreshes everything else.
 */
export function jobsFor(config: Pick<Config, 'archive' | 'sources'>, opts: { judge: boolean }): JobSpec[] {
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
      isDue: () => judgeDue(config),
      start: (env) => runDetached('judge.ts', [], env, stderrPath(config.archive, 'judge')),
      deadlineMs: JUDGE_DEADLINE_MS,
      staleMs: JUDGE_STALE_MS,
      bootGraceMs: BOOT_GRACE_MS,
    });
  }
  return jobs;
}

/** Enabled, and the live session has grown enough or some session has never been read. */
function judgeDue(config: Pick<Config, 'archive' | 'sources'>): boolean {
  if (legacyJudgeRunning(config.archive)) return false;
  const state = readJudgeState(config.archive);
  if (!state.settings.enabled) return false;
  const current = resolveCurrentSession(config.sources);
  if (current !== undefined) {
    try {
      if (dueForJudging(state, current.sessionId, statSync(current.source).size)) return true;
    } catch {
      // Unreadable live session: the backlog check still applies.
    }
  }
  return oldestUnread(state, sessionSizes(config.sources)) !== undefined;
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
  opts: { judge: boolean },
): Record<string, string> {
  retireLegacy(config.archive);
  return supervise(jobsFor(config, opts), { archive: config.archive, clean });
}

export function jobsHealth(archive: string): JobHealth[] {
  return health(archive, [...JOB_NAMES]);
}
