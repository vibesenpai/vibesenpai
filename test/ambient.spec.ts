/** The breaker, the standing and the backlog: Principle Zero as tests. */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJudgeState } from '../src/judge/state.ts';
import { JUDGE_SECONDS_PER_CALL, oldestUnread, pendingWork, progressLine } from '../src/judge/schedule.ts';
import {
  computeStanding, isFresh, readStanding, writeStanding,
  type SessionInput, type Standing,
} from '../src/standing.ts';
import { editRetry } from '../src/detect/edit-retry.ts';
import type { Event } from '../src/types.ts';
import { duration, localStamp } from '../src/format.ts';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'as-ambient-'));


describe('standing — history is processed so day one is not blank', () => {
  const session = (id: string, events: Event[]): SessionInput => ({
    sessionId: id,
    project: 'p',
    events,
  });

  let n = 0;
  const ev2 = (over: Partial<Event> & Pick<Event, 'turnType'>): Event => {
    n += 1;
    return {
      sessionId: 's',
      harness: 'claude-code',
      uuid: over.uuid ?? `s${n}`,
      parentUuid: null,
      seq: over.seq ?? n,
      isSidechain: false,
      ...over,
    } as Event;
  };

  /** A failed-then-retried edit, using the harness's real message. */
  const retryPair = (path: string): Event[] => {
    const call = ev2({ turnType: 'tool_use', toolName: 'Edit', filePath: path, toolCallId: `c${n}`, argHash: 'h1' });
    return [
      call,
      ev2({
        turnType: 'tool_result', toolCallId: call.toolCallId as string, isError: true, failureKind: 'tool',
        textSummary: '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>',
      }),
      ev2({ turnType: 'tool_use', toolName: 'Edit', filePath: path, toolCallId: `c${n}b`, argHash: 'h2' }),
    ];
  };

  it('aggregates occurrences and session spread across history', async () => {
    const { standing: s } = await computeStanding(
      [session('a', retryPair('/x.ts')), session('b', retryPair('/y.ts')), session('c', [])],
      [editRetry()],
      { now: '2026-10-19T12:00:00.000Z' },
    );
    expect(s.sessions).toBe(3);
    expect(s.dimensions).toEqual([
      {
        dimension: 'edit_retry',
        occurrences: 2,
        sessions: 2,
        files: 2,
        top: { subject: '/x.ts', occurrences: 1 },
      },
    ]);
    expect(s.reasons).toEqual({ 'not-read-first': 2 });
  });

  it('reports sessions it could not read rather than dropping them', async () => {
    const { standing: s } = await computeStanding([session('a', retryPair('/x.ts'))], [editRetry()], { unreadable: 4 });
    expect(s.unreadable).toBe(4);
  });

  it('survives a missing or corrupt file', () => {
    const dir = scratch();
    expect(readStanding(dir)).toBeUndefined();
    writeFileSync(join(dir, 'standing.json'), 'not json');
    expect(readStanding(dir)).toBeUndefined();
    writeFileSync(join(dir, 'standing.json'), JSON.stringify({ v: 99, dimensions: [] }));
    expect(readStanding(dir)).toBeUndefined();
  });

  it('round-trips through the archive', async () => {
    const dir = scratch();
    const { standing: s } = await computeStanding([session('a', retryPair('/x.ts'))], [editRetry()]);
    expect(writeStanding(dir, s)).toBe(true);
    expect(readStanding(dir)).toEqual(s);
  });

  it('will not recompute while fresh, so four windows do not parse four times', () => {
    const now = Date.parse('2026-10-19T12:00:00.000Z');
    const fresh = { ...({} as Standing), v: 1, computedAt: '2026-10-19T11:59:00.000Z', dimensions: [] };
    const stale = { ...fresh, computedAt: '2026-10-19T10:00:00.000Z' };
    expect(isFresh(fresh as Standing, now)).toBe(true);
    expect(isFresh(stale as Standing, now)).toBe(false);
    expect(isFresh(undefined, now)).toBe(false);
  });

  it('shows the computed time in local, not UTC', async () => {
    const { standing: s } = await computeStanding([session('a', [])], [editRetry()], { now: '2026-10-19T12:00:00.000Z' });
    const local = localStamp(s.computedAt);
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(local).not.toContain('T');
  });
});

describe('standing — what is still to read', () => {
  it('reports nothing pending when every session is up to date', () => {
    const state = { ...readJudgeState(scratch()), ledger: { a: 500, b: 200 } };
    const w = pendingWork(state, [
      { id: 'a', sizeBytes: 500 },
      { id: 'b', sizeBytes: 200 },
    ]);
    // `unread` = never read; `behind` = read, then grew. A live session is always `behind`.
    expect(w).toEqual({ pending: 0, judged: 2, unread: 0, behind: 0, seconds: 0 });
  });

  it('counts a grown session as pending and estimates two calls for it', () => {
    const state = { ...readJudgeState(scratch()), ledger: { a: 500 } };
    const w = pendingWork(state, [
      { id: 'a', sizeBytes: 900 },
      { id: 'new', sizeBytes: 100 },
    ]);
    expect(w.pending).toBe(2);
    expect(w.judged).toBe(0);
    // A ceiling: a batch holds as many sessions as fit the token limit.
    expect(w.seconds).toBe(2 * 2 * JUDGE_SECONDS_PER_CALL);
  });

  it('rounds a duration coarsely, because the estimate is an average', () => {
    expect(duration(45)).toBe('45 seconds');
    expect(duration(60)).toBe('60 seconds');
    expect(duration(300)).toBe('5 minutes');
    expect(duration(60 * 60)).toBe('60 minutes');
    expect(duration(3 * 3600)).toBe('3.0 hours');
    // No false precision: never "5m 12s".
    expect(duration(312)).not.toMatch(/\d+m/);
  });
});

describe('the backlog drains, which it did not', () => {
  // Regression: the `Stop` hook judged only the live session, so the backlog never drained.
  const state = (ledger: Record<string, number>) =>
    ({ ...readJudgeState(scratch()), ledger }) as Parameters<typeof oldestUnread>[0];
  const sizes = [
    { id: 'old', sizeBytes: 100, mtimeMs: 1 },
    { id: 'mid', sizeBytes: 100, mtimeMs: 2 },
    { id: 'new', sizeBytes: 100, mtimeMs: 3 },
  ];

  it('picks the session nobody has ever looked at, oldest first', () => {
    expect(oldestUnread(state({}), sizes)).toBe('old');
  });

  it('skips one that was read and merely grew', () => {
    // A live session is always pending; returning to it would starve unread ones.
    expect(oldestUnread(state({ old: 50 }), sizes)).toBe('mid');
  });

  it('walks forward rather than stalling on one session', () => {
    const ledger: Record<string, number> = {};
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = oldestUnread(state(ledger), sizes);
      if (id === undefined) break;
      order.push(id);
      ledger[id] = 100;
    }
    expect(order).toEqual(['old', 'mid', 'new']);
  });

  it('has nothing to offer once everything has been read', () => {
    expect(oldestUnread(state({ old: 100, mid: 100, new: 100 }), sizes)).toBeUndefined();
  });

  it('is a reason to start a pass, not a narrowing of what it reads', () => {
    // Regression: the live session was always due, so the backlog branch never ran.
    // A pass with no session id batches everything pending, live session included.
    const jobs = readFileSync('src/jobs.ts', 'utf8');
    expect(jobs, 'the backlog is still a reason to start').toMatch(/oldestUnread/);
    expect(jobs, 'and so is the live session').toMatch(/dueForJudging/);
    expect(jobs, 'but the pass is never narrowed to one session').toMatch(/runDetached\('judge\.ts', \[\],/);
  });
});

describe('the ETA is in the unit that governs it', () => {
  // The queue drains when a turn ends, so it is stated in sessions, not minutes.
  it('counts queued work in sessions and turns, never minutes', () => {
    const line = progressLine({ unread: 24 });
    expect(line).toMatch(/24 sessions/);
    expect(line).toMatch(/when a turn ends/);
    expect(line, 'a queue paced by turns must not quote minutes').not.toMatch(/minute|second/);
  });

  it('gives a real duration only for a pass actually in flight', () => {
    const line = progressLine({ unread: 24, running: { elapsedMs: 20_000 } });
    expect(line).toMatch(/Reading a session now/);
    expect(line).toMatch(/40 seconds left/);
  });

  it('prefers what calls really took here over the constant', () => {
    const line = progressLine({ unread: 0, running: { elapsedMs: 2_000 }, callMs: 5_000 });
    expect(line, '2 x 5s measured, 2s elapsed → 8s left').toMatch(/8 seconds left/);
  });

  it('says so rather than counting past the estimate', () => {
    expect(progressLine({ unread: 0, running: { elapsedMs: 10 * 60_000 } })).toMatch(/nearly done/);
  });

  it('covers the window where a pass is spawned but has not recorded itself', () => {
    // The spawner writes the marker before the pass records its `run` row.
    expect(progressLine({ unread: 3, spawned: true })).toBe('Reading a session now.');
  });

  it('says nothing at all when there is nothing outstanding', () => {
    expect(progressLine({ unread: 0 })).toBe('');
  });
});
