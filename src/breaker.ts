/**
 * Circuit breaker: after `TRIP_AFTER` consecutive failures the hook stops spawning and records why for `doctor`.
 * Never throws; an unreadable breaker counts as closed, so a corrupt file cannot disable the tool forever.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from './files.ts';

const FILE = 'breaker.json';

/** Consecutive failures before the hook stops trying. */
export const TRIP_AFTER = 5;

type Breaker = {
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
    // Unreadable means closed.
    return closed();
  }
}

function writeBreaker(archive: string, b: Breaker): void {
  try {
    writeJson(pathFor(archive), b);
  } catch {
    // A breaker that cannot persist forgets; better than a hook that throws.
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
