/** The `judge.running` lock: one pass at a time, released by the process that took it. */

import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Age after which a lock is stale. Without it, two passes inside one ~30s ledger window bill twice.
 * Long passes keep it fresh with `touchJudgeLock`.
 */
export const JUDGE_RUNNING_STALE_MS = 5 * 60 * 1000;

export const RUNNING = 'judge.running';

export function judgeRunning(archive: string, now = Date.now()): boolean {
  try {
    return Math.abs(now - statSync(join(archive, RUNNING)).mtimeMs) < JUDGE_RUNNING_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Take the lock, or return false if another live process holds it.
 * Atomic: `mkdirSync` without `recursive` fails with EEXIST. The owner pid goes inside.
 */
export function takeJudgeLock(archive: string, now = Date.now()): boolean {
  try {
    mkdirSync(archive, { recursive: true, mode: 0o700 });
  } catch {
    return false;
  }

  const dir = join(archive, RUNNING);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch {
    // Held, unless stale: break it once and retry.
    if (judgeRunning(archive, now)) return false;
    try {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { mode: 0o700 });
    } catch {
      return false;
    }
  }

  // rm-then-mkdir is not atomic; reading our pid back lets the loser of a race notice.
  try {
    writeFileSync(join(dir, 'owner'), `${process.pid}\n${new Date(now).toISOString()}\n`, {
      mode: 0o600,
    });
    const back = Number.parseInt(
      readFileSync(join(dir, 'owner'), 'utf8').split('\n')[0] ?? '',
      10,
    );
    if (Number.isFinite(back) && back !== process.pid) return false;
  } catch {
    // The directory is the lock; a missing stamp is not a reason to refuse work.
  }
  return true;
}

export function clearJudgeRunning(archive: string, pid = process.pid): void {
  const dir = join(archive, RUNNING);
  try {
    // Only release a lock we hold; someone else's ages out on its own.
    const owner = Number.parseInt(readFileSync(join(dir, 'owner'), 'utf8').split('\n')[0] ?? '', 10);
    if (Number.isFinite(owner) && owner !== pid) return;
  } catch {
    // No stamp (interrupted mid-write): remove it.
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Staleness covers this.
  }
}

/**
 * The spawner's pid, passed to the detached pass so it can release the lock the spawner took.
 * Without it every lock aged out and the 5-minute staleness paced the whole judge.
 */
export const JUDGE_LOCK_OWNER_ENV = 'AGENTSENSEI_JUDGE_LOCK_OWNER';

export function judgeLockOwner(env: NodeJS.ProcessEnv = process.env): number {
  const pid = Number.parseInt(env[JUDGE_LOCK_OWNER_ENV] ?? '', 10);
  return Number.isFinite(pid) ? pid : process.pid;
}

/** Bump the lock's mtime so a long-running pass is not taken over as stale. */
export function touchJudgeLock(archive: string, now = Date.now()): void {
  try {
    const t = new Date(now);
    utimesSync(join(archive, RUNNING), t, t);
  } catch {
    // No lock to refresh; the pass carries on and staleness decides.
  }
}
