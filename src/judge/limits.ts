/**
 * The automatic pass's spend limits: tokens per local day, and a one-time catch-up on past sessions.
 * Only the pass the Stop hook spawns is limited; explicit runs and benchmarks are not. See .claude/rules/judge.md.
 */

import { clearCatchUpFrom, openStore, readCatchUpFrom, tokensSince, writeCatchUpFrom, type Db } from '../store.ts';
import type { JudgeState } from './state.ts';

/** Set by the Stop hook on the pass it spawns. */
export const LIMITS_ENV = 'VIBESENPAI_LIMITS';

export function limited(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LIMITS_ENV] === '1';
}

/** Invocation overhead per call (measured ~26k); a batch makes at most two calls. */
export const CALL_OVERHEAD_TOKENS = 26_000;

export function batchCost(packetTokens: number): number {
  return packetTokens + 2 * CALL_OVERHEAD_TOKENS;
}

/** Local midnight, as an ISO instant. */
export function startOfDay(now = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

/** The leading batches whose estimated cost fits in `left`; the rest wait for another day. */
export function withinBudget<T>(batches: T[], cost: (b: T) => number, left: number): T[] {
  const out: T[] = [];
  let used = 0;
  for (const b of batches) {
    used += cost(b);
    if (used > left) break;
    out.push(b);
  }
  return out;
}

/** Tokens left today; the label call can overshoot by one round at most. */
export function budgetLeft(db: Db, dailyTokens: number, now = new Date()): number {
  return dailyTokens - tokensSince(db, startOfDay(now));
}

type Sized = { id: string; mtimeMs: number };

const started = (state: Pick<JudgeState, 'ledger' | 'parts'>, id: string): boolean =>
  (state.ledger[id] ?? 0) > 0 || state.parts?.[id] !== undefined;

/** The `n`th newest never-read session's mtime; 0 when there are no more than `n`. */
export function catchUpCutoff(state: Pick<JudgeState, 'ledger' | 'parts'>, sessions: Sized[], n: number): number {
  const unread = sessions.filter((s) => !started(state, s.id)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  return unread.length <= n ? 0 : (unread[n - 1]?.mtimeMs ?? 0);
}

/** Sessions the automatic pass may read: already started, or last written at or after the cutoff. */
export function eligible<T extends Sized>(state: Pick<JudgeState, 'ledger' | 'parts'>, sessions: T[], cutoff: number): T[] {
  return sessions.filter((s) => started(state, s.id) || s.mtimeMs >= cutoff);
}

/**
 * The stored cutoff, or one computed now. `persist` fixes it on the first limited pass, so later
 * passes never reach further back; a hook only reads.
 */
export function catchUpFrom(
  archive: string,
  state: Pick<JudgeState, 'ledger' | 'parts' | 'settings'>,
  sessions: Sized[],
  persist: boolean,
): number {
  let db: Db | undefined;
  try {
    db = openStore(archive);
    const stored = readCatchUpFrom(db);
    if (stored !== undefined) return stored;
    const cutoff = catchUpCutoff(state, sessions, state.settings.catchUp);
    if (persist) writeCatchUpFrom(db, cutoff);
    return cutoff;
  } catch {
    return catchUpCutoff(state, sessions, state.settings.catchUp);
  } finally {
    db?.close();
  }
}

/** Tokens left today for the automatic pass, or undefined when the store cannot be read. */
export function todayLeft(archive: string, dailyTokens: number): number | undefined {
  let db: Db | undefined;
  try {
    db = openStore(archive);
    return budgetLeft(db, dailyTokens);
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

/** Never-read sessions past the cutoff: read only by `judge --backlog --apply`. */
export function waitingOnRequest(
  archive: string,
  state: Pick<JudgeState, 'ledger' | 'parts' | 'settings'>,
  sessions: Sized[],
): number {
  const cutoff = catchUpFrom(archive, state, sessions, false);
  return sessions.filter((s) => !started(state, s.id) && s.mtimeMs < cutoff).length;
}

/** Forget the cutoff, so the next limited pass sets it again from `catchUp`. The user's explicit act. */
export function resetCatchUp(archive: string): boolean {
  let db: Db | undefined;
  try {
    db = openStore(archive);
    clearCatchUpFrom(db);
    return true;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}
