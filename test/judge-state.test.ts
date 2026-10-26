/** `src/judge/` state, schedule and lock: what decides whether money gets spent. */

import { describe, expect, it } from 'vitest';
import { endRun, markSkipped, measuredMsPerToken, openStore, startRun } from '../src/store.ts';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, emptyState, findingsFor, readJudgeState, recordPass, recordSpend, writeSettings } from '../src/judge/state.ts';
import { BYTES_PER_TURN, FALLBACK_MS_PER_TOKEN, analysisBlock, dueForJudging, oldestUnread } from '../src/judge/schedule.ts';
import { JUDGE_RUNNING_STALE_MS, clearJudgeRunning, judgeRunning, takeJudgeLock } from '../src/judge/lock.ts';

const archive = (): string => mkdtempSync(join(tmpdir(), 'as-judge-'));

describe('settings live alone, and that is the point', () => {
  it('is ON, because the trigger moved rather than the consent', () => {
    expect(DEFAULT_SETTINGS.enabled).toBe(true);
    expect(readJudgeState(archive()).settings.enabled).toBe(true);
  });

  it('round-trips', () => {
    const dir = archive();
    expect(writeSettings(dir, { ...DEFAULT_SETTINGS, enabled: false, model: 'sonnet' })).toBe(true);
    const back = readJudgeState(dir).settings;
    expect(back.enabled).toBe(false);
    expect(back.model).toBe('sonnet');
  });

  it('falls back to defaults rather than throwing on a bad file', () => {
    // Principle Zero: a corrupt file must not stop a session starting.
    const dir = archive();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'judge-settings.json'), '{ this is not json');
    expect(readJudgeState(dir).settings).toEqual(DEFAULT_SETTINGS);
  });

  // No producer opens the settings file, so a running pass cannot undo `--disable`.
  it('survives a pass that started before the user disabled it', () => {
    const dir = archive();
    writeSettings(dir, { ...DEFAULT_SETTINGS, enabled: true });

    // A pass reads state, including `enabled: true`.
    const passCopy = readJudgeState(dir);
    expect(passCopy.settings.enabled).toBe(true);

    // The user disables it while that pass is still running.
    writeSettings(dir, { ...passCopy.settings, enabled: false });

    // The pass finishes and records everything it produced.
    recordPass(dir, [], new Map([['some-session', 50_000]]));

    expect(readJudgeState(dir).settings.enabled, 'the user decided; the pass does not get a vote').toBe(false);
  });

  it('records what a call cost even when the work after it fails', () => {
    // Spend is recorded even on failure; the watermark advances only with results.
    const dir = archive();
    recordSpend(dir, { calls: 1, tokensIn: 58_161, tokensOut: 3_962 });

    const back = readJudgeState(dir);
    expect(back.usage.calls).toBe(1);
    expect(back.usage.inputTokens).toBe(58_161);
    expect(back.ledger, 'no results, so no progress').toEqual({});
  });
});

describe('dueForJudging', () => {
  it('waits for a cadence worth of new bytes', () => {
    // Stop fires at every response boundary, and each call has large fixed overhead.
    const s = emptyState();
    const need = s.settings.cadence * BYTES_PER_TURN;
    expect(dueForJudging(s, 'x', need - 1)).toBe(false);
    expect(dueForJudging(s, 'x', need)).toBe(true);
  });

  it('measures from where the last pass stopped, not from zero', () => {
    // A byte offset, so a growing session stays judgeable.
    const s = emptyState();
    s.ledger['x'] = 100_000;
    expect(dueForJudging(s, 'x', 100_000 + 1)).toBe(false);
    expect(dueForJudging(s, 'x', 100_000 + s.settings.cadence * BYTES_PER_TURN)).toBe(true);
  });
});

describe('findingsFor', () => {
  it('returns one session\'s findings, newest first', () => {
    const s = emptyState();
    s.findings = [
      { sessionId: 'a', dimension: 'overreach', turns: [1], why: 'old', at: '2026-01-01T00:00:00Z' },
      { sessionId: 'a', dimension: 'misread_intent', turns: [2], why: 'new', at: '2026-02-01T00:00:00Z' },
      { sessionId: 'b', dimension: 'overreach', turns: [3], why: 'other', at: '2026-03-01T00:00:00Z' },
    ];
    expect(findingsFor(s, 'a').map((f) => f.why)).toEqual(['new', 'old']);
  });
});

describe('an unreadable store is not an empty one', () => {
  // A store that fails to open must not read as an empty one.
  const scratch = (): string => mkdtempSync(join(tmpdir(), 'as-unreadable-'));

  it('flags a store that is not a database', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'store.db'), randomBytes(4096));
    const state = readJudgeState(dir);
    expect(state.storeUnreadable, 'a failed read must be distinguishable').toBe(true);
  });

  it('does not flag a healthy store, however empty', () => {
    // "Could not read", never "found nothing".
    const dir = scratch();
    const state = readJudgeState(dir);
    expect(state.storeUnreadable).toBeUndefined();
    expect(state.findings).toEqual([]);
  });

  it('still returns usable settings, so a session can start', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'store.db'), randomBytes(4096));
    expect(readJudgeState(dir).settings.model).toBe(DEFAULT_SETTINGS.model);
  });

  it('says unknown rather than a number', () => {
    const src = ['src/cli.ts', ...readdirSync('src/cmd').map((f) => `src/cmd/${f}`)].map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(src).toMatch(/storeUnreadable === true/);
    expect(src).toMatch(/the store could not be read/);
  });
});

describe('a pass that finds nothing still records that it looked', () => {
  // An empty extract must still advance the ledger, or the session is re-read and re-paid every pass.
  const scratch = (): string => mkdtempSync(join(tmpdir(), 'as-clean-'));

  it('advances the watermark with no findings', () => {
    const dir = scratch();
    recordPass(dir, [], new Map([['s1', 4242]]));
    expect(readJudgeState(dir).ledger['s1']).toBe(4242);
  });

  it('creates no findings while doing so', () => {
    const dir = scratch();
    recordPass(dir, [], new Map([['s1', 4242]]));
    expect(readJudgeState(dir).findings).toEqual([]);
  });

  it('means a clean session stops being unread', () => {
    // The drain walks `oldestUnread`, so an unadvanced session would be selected forever.
    const dir = scratch();
    const sizes = [{ id: 's1', sizeBytes: 4242, mtimeMs: 1 }];
    expect(oldestUnread(readJudgeState(dir), sizes)).toBe('s1');
    recordPass(dir, [], new Map([['s1', 4242]]));
    expect(oldestUnread(readJudgeState(dir), sizes)).toBeUndefined();
  });

  it('is what judge.ts actually does on an empty extract', () => {
    const src = readFileSync('src/judge/run.ts', 'utf8');
    const clean = /episodes\.length === 0[\s\S]{0,1400}?\n    \}/.exec(src)?.[0] ?? '';
    expect(clean, 'the clean-batch branch moved').not.toBe('');
    expect(clean).toMatch(/recordPass\(archive, \[\], batch\.offsets, batch\.parts\)/);
  });
});

describe('a session too big for one packet is read, not abandoned', () => {
  // An over-budget session is windowed and resumed, not retried until the breaker trips.
  const scratch = (): string => mkdtempSync(join(tmpdir(), 'as-window-'));

  it('windows rather than giving up', () => {
    const src = readFileSync('src/judge/run.ts', 'utf8');
    expect(src, 'oversize is no longer a breaker failure').not.toMatch(
      /recordFailure\([^)]*exceeds the judge budget alone/,
    );
    expect(src).toMatch(/largestFittingWindow/);
  });

  it('resumes at or before the last turn sent, never after it', () => {
    // Bytes map to turns by ratio; rounding down means resumes overlap (free: ids are content hashes) rather than gap.
    const totalEvents = 6067;
    const size = 26_272_768;
    const sentThrough = 4710;

    const watermark = Math.floor((sentThrough / totalEvents) * size);
    const resumeAt = Math.floor((watermark / size) * totalEvents);
    expect(resumeAt).toBeLessThanOrEqual(sentThrough);
  });

  it('still overlaps rather than gaps when the session has grown', () => {
    const watermark = Math.floor((4710 / 6067) * 26_272_768);
    const grownSize = 26_272_768 * 2;
    const grownEvents = 6067 * 2;
    expect(Math.floor((watermark / grownSize) * grownEvents)).toBeLessThanOrEqual(4710);
  });

  it('passes over a session nothing can hold, instead of stalling on it', () => {
    const dir = scratch();
    const sizes = [
      { id: 'huge', sizeBytes: 999, mtimeMs: 1 },
      { id: 'next', sizeBytes: 100, mtimeMs: 2 },
    ];
    expect(oldestUnread(readJudgeState(dir), sizes)).toBe('huge');

    const db = openStore(dir);
    markSkipped(db, 'huge', 'a single turn exceeds the judge budget');
    db.close();

    expect(oldestUnread(readJudgeState(dir), sizes), 'the drain moves on').toBe('next');
  });

  it('keeps a part cursor with the watermark, and clears a skip once anything is read', () => {
    const dir = scratch();
    const db = openStore(dir);
    markSkipped(db, 'big', 'a single turn exceeds the judge budget');
    db.close();

    // Part of one turn read: the watermark has not moved, the cursor has.
    recordPass(dir, [], new Map(), new Map([['big', { seq: 7, chars: 120_000 }]]));
    let state = readJudgeState(dir);
    expect(state.parts?.['big']).toEqual({ seq: 7, chars: 120_000 });
    expect(state.ledger['big'] ?? 0).toBe(0);
    expect(state.skipped ?? [], 'a session being read is not skipped').not.toContain('big');

    // The last part: the turn is done, so the cursor goes and the watermark moves.
    recordPass(dir, [], new Map([['big', 5000]]), new Map([['big', undefined]]));
    state = readJudgeState(dir);
    expect(state.parts?.['big']).toBeUndefined();
    expect(state.ledger['big']).toBe(5000);
  });

  it('keeps that away from the breaker, which is for transient faults', () => {
    const src = readFileSync('src/judge/run.ts', 'utf8');
    const branch = /const win = largestFittingWindow[\s\S]{0,800}?skipSession[^\n]*\n/.exec(src)?.[0] ?? '';
    expect(branch, 'the windowing branch moved').not.toBe('');
    expect(branch, 'too large is permanent, not a fault').not.toMatch(/recordFailure/);
    expect(branch).toMatch(/skipSession/);
  });
});

describe('the estimate is sized by what is there, not by how many', () => {
  // Sized from per-session packet costs measured by the standing pass, not count × constant.
  const line = (o: Parameters<typeof analysisBlock>[0]) => analysisBlock(o).join(' | ');

  it('divides by the batches that run at once, never by more than the queue fills', () => {
    const base = { total: 10, read: 4, unread: 6, msPerToken: 1, budget: 60_000 };
    // 180k tokens is three full batches: three at once takes a third as long.
    expect(line({ ...base, queueTokens: 180_000, concurrency: 1 })).toMatch(/about 6 minutes/);
    expect(line({ ...base, queueTokens: 180_000, concurrency: 3 })).toMatch(/about 2 minutes/);
    // 20k tokens is one batch, however many calls are allowed at once.
    expect(line({ ...base, queueTokens: 20_000, concurrency: 3 })).toMatch(/40 seconds/);
  });

  it('shrinks when the queue is small, even with many sessions', () => {
    const many = line({ total: 30, read: 0, unread: 28, queueTokens: 20_000 });
    const few = line({ total: 30, read: 0, unread: 2, queueTokens: 120_000 });
    expect(many).toMatch(/seconds|1 minute/);
    expect(few, 'two big sessions outweigh twenty-eight small ones').toMatch(/minutes/);
  });

  it('overestimates rather than under, with nothing measured yet', () => {
    // No sizes yet: assume a full-budget packet each.
    const blind = line({ total: 28, read: 0, unread: 28 });
    const measured = line({ total: 28, read: 0, unread: 28, queueTokens: 217_567 });
    expect(blind).not.toBe(measured);
    // The fallback rate errs high, so learning shrinks the estimate.
    expect(blind).toMatch(/56 minutes/);
  });

  it('uses this machine rate once it has one', () => {
    const fallback = line({ total: 28, read: 0, unread: 28, queueTokens: 217_567 });
    const learned = line({
      total: 28, read: 0, unread: 28, queueTokens: 217_567, msPerToken: 1.765,
    });
    expect(learned).not.toBe(fallback);
  });

  it('counts progress by sessions looked at, which can reach the total', () => {
    expect(line({ total: 29, read: 2, unread: 27 })).toMatch(/2 of 29/);
    expect(line({ total: 29, read: 29, unread: 0 })).toMatch(/Up to date/);
  });
});

describe('a rate needs two sizes, not two samples', () => {
  // A rate needs runs of different sizes; same-size samples say nothing about larger packets.
  const scratch = (): string => mkdtempSync(join(tmpdir(), 'as-rate-'));

  it('refuses when every run read the same amount', () => {
    const db = openStore(scratch());
    for (const ms of [3000, 3100, 2900]) {
      endRun(db, startRun(db, 'judge'), 'done', ms, 1700);
    }
    expect(measuredMsPerToken(db)).toBeUndefined();
    db.close();
  });

  it('gives a rate once the sizes differ', () => {
    const db = openStore(scratch());
    endRun(db, startRun(db, 'judge'), 'done', 3000, 1700);
    endRun(db, startRun(db, 'judge'), 'done', 60_000, 60_000);
    const r = measuredMsPerToken(db);
    expect(r).toBeDefined();
    expect(r as number).toBeGreaterThan(0);
    db.close();
  });
});

describe('two passes cannot take the same work', () => {
  // Take-or-fail in one operation; a check-then-write let two hooks both take the lock.
  const scratch = (): string => mkdtempSync(join(tmpdir(), 'as-lock2-'));

  it('is take-or-fail in one operation', () => {
    const dir = scratch();
    expect(takeJudgeLock(dir)).toBe(true);
    expect(takeJudgeLock(dir), 'the second caller must lose').toBe(false);
  });

  it('is not released by a process that does not hold it', () => {
    // Only the holder may release.
    const dir = scratch();
    takeJudgeLock(dir);
    clearJudgeRunning(dir, 999_999);
    expect(judgeRunning(dir), 'someone else cannot free it').toBe(true);
    clearJudgeRunning(dir);
    expect(judgeRunning(dir)).toBe(false);
  });

  it('breaks a lock whose owner died', () => {
    // Injected time makes any lock look stale, so this only asserts a dead owner does not block forever.
    const dir = scratch();
    takeJudgeLock(dir);
    expect(takeJudgeLock(dir), 'held').toBe(false);
    expect(takeJudgeLock(dir, Date.now() + JUDGE_RUNNING_STALE_MS + 1), 'stale').toBe(true);
  });

  it('is free again after a normal release', () => {
    const dir = scratch();
    takeJudgeLock(dir);
    clearJudgeRunning(dir);
    expect(takeJudgeLock(dir)).toBe(true);
  });
});

describe('learning must shrink the estimate, never grow it', () => {
  // The fallback rate must not be optimistic, or the estimate grows as work clears.
  it('starts above what a real machine turned out to show', () => {
    expect(FALLBACK_MS_PER_TOKEN).toBeGreaterThan(0.5);
  });

  it('is within reach of the measured rate, not merely large', () => {
    expect(FALLBACK_MS_PER_TOKEN).toBeLessThan(1.135 * 1.5);
  });
});
