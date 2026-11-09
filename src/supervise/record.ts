/** Job records and leases on disk. Every read tolerates a missing or corrupt file. */

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { writeJson } from '../files.ts';
import type { JobRecord, Lease } from './types.ts';

const jobsDir = (archive: string): string => join(archive, 'jobs');
const recordPath = (archive: string, name: string): string => join(jobsDir(archive), `${name}.json`);
const leaseDir = (archive: string, name: string): string => join(jobsDir(archive), `${name}.lease`);
const leaseFile = (archive: string, name: string): string => join(leaseDir(archive, name), 'lease.json');
export const stderrPath = (archive: string, name: string): string => join(jobsDir(archive), `${name}.stderr`);

export function emptyRecord(): JobRecord {
  return { failures: 0, paidFailures: 0 };
}

export function readRecord(archive: string, name: string): JobRecord {
  try {
    const raw = JSON.parse(readFileSync(recordPath(archive, name), 'utf8')) as Partial<JobRecord>;
    return {
      ...emptyRecord(),
      ...raw,
      failures: typeof raw.failures === 'number' ? raw.failures : 0,
      paidFailures: typeof raw.paidFailures === 'number' ? raw.paidFailures : 0,
    };
  } catch {
    return emptyRecord();
  }
}

export function writeRecord(archive: string, name: string, r: JobRecord): void {
  try {
    writeJson(recordPath(archive, name), r);
  } catch {
    // A record that cannot persist forgets; never worth throwing from a hook.
  }
}

export function readLease(archive: string, name: string): Lease | undefined {
  try {
    const l = JSON.parse(readFileSync(leaseFile(archive, name), 'utf8')) as Lease;
    return typeof l.token === 'string' ? l : undefined;
  } catch {
    // The directory may exist with no file yet (mid-take) or a torn one: the age check handles it.
    return undefined;
  }
}

/** Age of the lease directory, or undefined if there is none. Covers a lease whose file never landed. */
export function leaseAgeMs(archive: string, name: string, now = Date.now()): number | undefined {
  try {
    return now - statSync(leaseDir(archive, name)).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Take the lease atomically (`mkdir` fails if it exists). Returns the new lease, or undefined if held. */
export function takeLease(archive: string, name: string, deadlineMs: number, now = Date.now()): Lease | undefined {
  try {
    mkdirSync(jobsDir(archive), { recursive: true, mode: 0o700 });
    mkdirSync(leaseDir(archive, name));
  } catch {
    return undefined;
  }
  const lease: Lease = {
    token: randomBytes(8).toString('hex'),
    spawnedAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + deadlineMs).toISOString(),
  };
  writeLease(archive, name, lease);
  return lease;
}

export function writeLease(archive: string, name: string, lease: Lease): void {
  try {
    writeFileSync(leaseFile(archive, name), JSON.stringify(lease), { mode: 0o600 });
  } catch {
    // The age check reclaims a lease whose file never landed.
  }
}

/** Release, but only a lease we hold: a reclaimed worker must not free its successor's. */
export function releaseLease(archive: string, name: string, token?: string): void {
  if (token !== undefined && readLease(archive, name)?.token !== token) return;
  try {
    rmSync(leaseDir(archive, name), { recursive: true, force: true });
  } catch {
    // Reclaimed on age.
  }
}

/** Does this token still hold the lease? The worker checks before anything it cannot take back. */
export function holds(archive: string, name: string, token: string): boolean {
  return readLease(archive, name)?.token === token;
}
