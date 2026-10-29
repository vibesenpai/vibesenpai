/** The supervisor core: decisions on a fake clock, the back-off ladder, the paid hold, and its import boundary. */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcile, type Observed } from '../src/supervise/reconcile.ts';
import { afterRun, FREE_BACKOFF_MS, PAID_HOLD_AFTER } from '../src/supervise/backoff.ts';
import { emptyRecord, readRecord, takeLease, writeRecord } from '../src/supervise/record.ts';
import { health, releaseHold } from '../src/supervise/health.ts';
import type { JobRecord, Lease } from '../src/supervise/types.ts';

const SPEC = { deadlineMs: 60 * 60_000, staleMs: 5 * 60_000, bootGraceMs: 60_000 };
const T0 = Date.parse('2026-10-26T10:00:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();

function observe(over: Partial<Observed> = {}): Observed {
  return { record: emptyRecord(), lease: undefined, leaseAgeMs: undefined, due: false, now: T0, alive: () => false, ...over };
}
const lease = (over: Partial<Lease> = {}): Lease => ({
  token: 't', spawnedAt: iso(T0 - 10_000), deadlineAt: iso(T0 + SPEC.deadlineMs), ...over,
});

describe('reconcile', () => {
  it('starts a due job and leaves an idle one alone', () => {
    expect(reconcile(SPEC, observe({ due: true })).kind).toBe('start');
    expect(reconcile(SPEC, observe()).kind).toBe('idle');
  });

  it('reclaims at once when the recorded pid is dead, and says how it died', () => {
    const dead = observe({ alive: () => false });
    expect(reconcile(SPEC, { ...dead, lease: lease({ pid: 1 }) })).toEqual({ kind: 'reclaim', why: 'never-started' });
    expect(reconcile(SPEC, { ...dead, lease: lease({ pid: 1, startedAt: iso(T0 - 5000) }) })).toEqual({ kind: 'reclaim', why: 'died' });
    const late = lease({ pid: 1, startedAt: iso(T0 - 5000), deadlineAt: iso(T0 - 1) });
    expect(reconcile(SPEC, { ...dead, lease: late })).toEqual({ kind: 'reclaim', why: 'overran' });
  });

  it('never reclaims a live process on time alone, until twice its deadline', () => {
    const slept = lease({ pid: 1, startedAt: iso(T0 - 2 * 3600_000), heartbeatAt: iso(T0 - 3600_000), deadlineAt: iso(T0 - 1) });
    expect(reconcile(SPEC, observe({ lease: slept, alive: () => true })).kind).toBe('running');
    const ancient = lease({ pid: 1, spawnedAt: iso(T0 - 3 * SPEC.deadlineMs), startedAt: iso(T0 - 3 * SPEC.deadlineMs) });
    expect(reconcile(SPEC, observe({ lease: ancient, alive: () => true }))).toEqual({ kind: 'reclaim', why: 'overran' });
  });

  it('with no pid, waits out the boot grace and the heartbeat before reclaiming', () => {
    expect(reconcile(SPEC, observe({ lease: lease() })).kind).toBe('running');
    const old = lease({ spawnedAt: iso(T0 - 2 * SPEC.bootGraceMs) });
    expect(reconcile(SPEC, observe({ lease: old }))).toEqual({ kind: 'reclaim', why: 'never-started' });
    const silent = lease({ startedAt: iso(T0 - 600_000), heartbeatAt: iso(T0 - 600_000) });
    expect(reconcile(SPEC, observe({ lease: silent }))).toEqual({ kind: 'reclaim', why: 'died' });
  });

  it('reclaims a lease directory whose file never landed, after the boot grace', () => {
    expect(reconcile(SPEC, observe({ leaseAgeMs: 1000 })).kind).toBe('running');
    expect(reconcile(SPEC, observe({ leaseAgeMs: 2 * SPEC.bootGraceMs })).kind).toBe('reclaim');
  });

  it('waits out a back-off, then allows one trial run', () => {
    const r: JobRecord = { ...emptyRecord(), failures: 2, retryAt: iso(T0 + 1000) };
    expect(reconcile(SPEC, observe({ record: r, due: true })).kind).toBe('backoff');
    expect(reconcile(SPEC, observe({ record: r, due: true, now: T0 + 2000 })).kind).toBe('start');
  });

  it('holds after repeated paid failures, however due the job is', () => {
    expect(reconcile(SPEC, observe({ record: { ...emptyRecord(), held: true }, due: true })).kind).toBe('held');
  });
});

describe('afterRun', () => {
  it('climbs the free ladder and never stops retrying', () => {
    let r = emptyRecord();
    for (let i = 0; i < 8; i += 1) r = afterRun(r, { status: 'failed', kind: 'free', reason: 'x' }, T0);
    expect(r.held).toBeUndefined();
    expect(Date.parse(r.retryAt as string) - T0).toBe(FREE_BACKOFF_MS.at(-1));
    expect(r.firstFailureAt).toBe(iso(T0));
  });

  it('holds after the paid limit, so a deterministic fault cannot bill on a loop', () => {
    let r = emptyRecord();
    for (let i = 0; i < PAID_HOLD_AFTER - 1; i += 1) r = afterRun(r, { status: 'failed', kind: 'paid', reason: 'x' }, T0);
    expect(r.held).toBeUndefined();
    r = afterRun(r, { status: 'failed', kind: 'paid', reason: 'reply could not be parsed' }, T0);
    expect(r.held).toBe(true);
  });

  it('one success clears everything', () => {
    const r = afterRun({ ...emptyRecord(), failures: 4, paidFailures: 2 }, { status: 'ok' }, T0);
    expect(r).toEqual({ failures: 0, paidFailures: 0, lastEnd: { at: iso(T0), status: 'ok' } });
  });
});

describe('records on disk', () => {
  it('reads a corrupt or missing record as empty, so it can never disable a job', () => {
    const a = mkdtempSync(join(tmpdir(), 'as-sup-'));
    expect(readRecord(a, 'judge')).toEqual(emptyRecord());
  });

  it('takes a lease once; the second taker loses', () => {
    const a = mkdtempSync(join(tmpdir(), 'as-sup-'));
    expect(takeLease(a, 'judge', 1000)).toBeDefined();
    expect(takeLease(a, 'judge', 1000)).toBeUndefined();
  });

  it('reports a hold with its reason, and only an explicit release clears it', () => {
    const a = mkdtempSync(join(tmpdir(), 'as-sup-'));
    writeRecord(a, 'judge', { ...emptyRecord(), held: true, paidFailures: 3, lastEnd: { at: iso(T0), status: 'failed', kind: 'paid', reason: 'reply could not be parsed' } });
    expect(health(a, ['judge'])[0]).toMatchObject({ state: 'held', reason: 'reply could not be parsed' });
    releaseHold(a, 'judge');
    expect(health(a, ['judge'])[0]?.state).toBe('never-ran');
  });
});

describe('the core knows no harness', () => {
  it('imports only node built-ins, its own files and src/files.ts', () => {
    for (const f of readdirSync('src/supervise')) {
      const src = readFileSync(join('src/supervise', f), 'utf8');
      for (const m of src.matchAll(/from '([^']+)'/g)) {
        const spec = m[1] as string;
        const ok = spec.startsWith('node:') || spec.startsWith('./') || spec === '../files.ts';
        expect(ok, `src/supervise/${f} imports ${spec}`).toBe(true);
      }
    }
  });
});
