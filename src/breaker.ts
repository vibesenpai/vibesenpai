/**
 * The circuit breaker. Degrading to silence beats degrading to noise.
 *
 * Principle Zero requires that a broken analyzer never breaks a session, and a
 * hook that fails every boundary is still a cost even when each failure is
 * harmless: it spawns a process, burns a timeout, and does it again forever.
 * After `TRIP_AFTER` consecutive failures the hook stops spawning and records
 * why, so `agentsensei doctor` can say what happened instead of leaving someone
 * to wonder why nothing appears.
 *
 * Reads never throw and writes never throw. A breaker that could not be read is
 * treated as closed — the failure mode is attempting work, not refusing it,
 * because a corrupt breaker file must not permanently disable the tool.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'breaker.json';

/** Consecutive failures before the hook stops trying. */
export const TRIP_AFTER = 5;

export type Breaker = {
  consecutiveFailures: number;
  /** Why it tripped, for `doctor`. Never a stack trace — a sentence. */
  reason?: string;
  trippedAt?: string;
};

export function closed(): Breaker {
  return { consecutiveFailures: 0 };
}

function pathFor(archive: string): string {
  return join(archive, FILE);
}

export function readBreaker(archive: string): Breaker {
  try {
    const raw = JSON.parse(readFileSync(pathFor(archive), 'utf8')) as Partial<Breaker>;
    return {
      consecutiveFailures:
        typeof raw.consecutiveFailures === 'number' ? raw.consecutiveFailures : 0,
      ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
      ...(typeof raw.trippedAt === 'string' ? { trippedAt: raw.trippedAt } : {}),
    };
  } catch {
    // Unreadable means closed. A corrupt file must not disable the tool forever.
    return closed();
  }
}

export function writeBreaker(archive: string, b: Breaker): void {
  try {
    mkdirSync(archive, { recursive: true, mode: 0o700 });
    const tmp = `${pathFor(archive)}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(b, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, pathFor(archive));
  } catch {
    // A breaker we cannot persist is a breaker that forgets. Acceptable; the
    // alternative is a hook that throws.
  }
}

export function isTripped(b: Breaker): boolean {
  return b.consecutiveFailures >= TRIP_AFTER;
}

export function recordFailure(archive: string, reason: string): void {
  const b = readBreaker(archive);
  const next: Breaker = {
    consecutiveFailures: b.consecutiveFailures + 1,
    reason,
    ...(b.trippedAt !== undefined ? { trippedAt: b.trippedAt } : {}),
  };
  if (isTripped(next) && next.trippedAt === undefined) next.trippedAt = new Date().toISOString();
  writeBreaker(archive, next);
}

/** One success closes it completely — a transient failure must not linger. */
export function recordSuccess(archive: string): void {
  const b = readBreaker(archive);
  if (b.consecutiveFailures === 0 && b.reason === undefined) return;
  writeBreaker(archive, closed());
}
