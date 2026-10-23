/**
 * `src/judge-store.ts` — the state that decides whether money gets spent.
 */

import { describe, expect, it } from 'vitest';
import { endRun, markSkipped, measuredMsPerToken, openStore, startRun } from '../src/store.ts';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BYTES_PER_TURN,
  DEFAULT_SETTINGS,
  analysisBlock,
  dueForJudging,
  emptyState,
  findingsFor,
  oldestUnread,
  readJudgeState,
  recordPass,
  recordSpend,
  writeSettings,
} from '../src/judge-store.ts';

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

  // ── The consent race, which used to be real ──────────────────────────────
  //
  // Settings shared `judge.json` with the ledger, the findings and the usage
  // counters. A pass holds whole state in memory for up to six minutes and
  // rewrote all of it on the way out — so a user who ran `judge --disable
  // --apply` mid-pass had it silently set back to `true`. The user turns the
  // model off and the tool turns it on.
  //
  // The fix is structural rather than a lock: **no producer opens the settings
  // file**, so a pass cannot undo a decision it never reads.
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
    // Spend is not conditional on success: the money left the account when the
    // call returned. The watermark is conditional, because it means "we have
    // results", and advancing it first is how this project lost paid-for
    // episodes whenever stage B threw.
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
    // Stop fires at every response boundary — ~788 times in one real session —
    // and an invocation costs 26,384 tokens of overhead before our packet.
    const s = emptyState();
    const need = s.settings.cadence * BYTES_PER_TURN;
    expect(dueForJudging(s, 'x', need - 1)).toBe(false);
    expect(dueForJudging(s, 'x', need)).toBe(true);
  });

  it('measures from where the last pass stopped, not from zero', () => {
    // The ledger is a byte offset precisely so a growing session stays
    // judgeable: a boolean would judge it once at turn 50 and never at 800.
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
  // `readProgress` catches — it must, Principle Zero outranks a correct count
  // — but it returned a value **identical to an empty store**. So
  // `judge --status` printed `judged 0 session(s) · 0 finding(s)` over a
  // database it had failed to open, which is this project's own
  // `inaccurate_self_report` dimension appearing in its own status output.
  const scratch = (): string => mkdtempSync(join(tmpdir(), 'as-unreadable-'));

  it('flags a store that is not a database', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'store.db'), randomBytes(4096));
    const state = readJudgeState(dir);
    expect(state.storeUnreadable, 'a failed read must be distinguishable').toBe(true);
  });

  it('does not flag a healthy store, however empty', () => {
    // The flag means "could not read", never "found nothing" — otherwise the
    // honest case starts reporting unknown and the warning becomes noise.
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
    const src = readFileSync('src/cli.ts', 'utf8');
    expect(src).toMatch(/storeUnreadable === true/);
    expect(src).toMatch(/the store could not be read/);
  });
});

describe('a pass that finds nothing still records that it looked', () => {
  // `judge.ts` returned on `episodes.length === 0` without calling
  // `recordPass`, and its own comment called that **the common case** — so
  // most sessions never left `unread`. Visible on a real machine as
  // `0 of 29 sessions read` after five completed passes, against an empty
  // ledger.
  //
  // Worse than cosmetic: an unmarked session is re-read and re-paid for by
  // every pass that reaches it, which is the waste this tool exists to detect.
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
    // The drain walks `oldestUnread`, which reads the ledger. A session that
    // never advanced it would be selected for ever.
    const dir = scratch();
    const sizes = [{ id: 's1', sizeBytes: 4242, mtimeMs: 1 }];
    expect(oldestUnread(readJudgeState(dir), sizes)).toBe('s1');
    recordPass(dir, [], new Map([['s1', 4242]]));
    expect(oldestUnread(readJudgeState(dir), sizes)).toBeUndefined();
  });

  it('is what judge.ts actually does on an empty extract', () => {
    const src = readFileSync('scripts/judge.ts', 'utf8');
    const clean = /episodes\.length === 0[\s\S]{0,1400}?\n  \}/.exec(src)?.[0] ?? '';
    expect(clean, 'the clean-batch branch moved').not.toBe('');
    expect(clean).toMatch(/recordPass\(config\.archive, \[\], offsets\)/);
  });
});

describe('a session too big for one packet is read, not abandoned', () => {
  // It used to call `recordFailure` and return without advancing the
  // watermark. Harmless while the Stop hook only judged the live session;
  // once it began draining the backlog it would select the same session on
  // every idle turn boundary, and five of those trip the breaker and disable
  // the judge entirely.
  //
  // Measured on a real archive: 1 of 29 sessions is over budget, at 66,196
  // tokens against a 60,000 ceiling — and it windows into 4,710 turns then
  // 1,357. Two passes, nothing abandoned.
  const scratch = (): string => mkdtempSync(join(tmpdir(), 'as-window-'));

  it('windows rather than giving up', () => {
    const src = readFileSync('scripts/judge.ts', 'utf8');
    expect(src, 'oversize is no longer a breaker failure').not.toMatch(
      /recordFailure\([^)]*exceeds the judge budget alone/,
    );
    expect(src).toMatch(/largestFittingWindow/);
  });

  it('resumes at or before the last turn sent, never after it', () => {
    // The watermark is bytes and the window is turns, so the two map through a
    // ratio. Rounding down is what makes the round trip safe: a resume lands
    // at or before where we stopped, so turns overlap rather than being
    // skipped — and overlap is free, because occurrence ids are content
    // hashes.
    const totalEvents = 6067;
    const size = 26_272_768;
    const sentThrough = 4710;

    const watermark = Math.floor((sentThrough / totalEvents) * size);
    const resumeAt = Math.floor((watermark / size) * totalEvents);
    expect(resumeAt).toBeLessThanOrEqual(sentThrough);
  });

  it('still overlaps rather than gaps when the session has grown', () => {
    // A growing session increases both the size and the event count, which
    // moves the resume point earlier still.
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

  it('keeps that away from the breaker, which is for transient faults', () => {
    const src = readFileSync('scripts/judge.ts', 'utf8');
    const branch = /const win = largestFittingWindow[\s\S]{0,800}?skipSession[^\n]*\n/.exec(src)?.[0] ?? '';
    expect(branch, 'the windowing branch moved').not.toBe('');
    expect(branch, 'too large is permanent, not a fault').not.toMatch(/recordFailure/);
    expect(branch).toMatch(/skipSession/);
  });
});

describe('the estimate is sized by what is there, not by how many', () => {
  // It was `unread × a per-session constant`, which assumes sessions are
  // interchangeable. Measured across 29 real ones, their packets span 1,075
  // to 66,196 tokens — so a queue of small sessions looked identical to one
  // holding a 66k session.
  //
  // Nothing cheap predicts the size either: tokens per KB spans 1.5 to 9.4,
  // and tokens against event count is not even monotonic (6,067 events →
  // 66,196 tokens; 7,013 → 55,691, because same-role turns merge). So it is
  // measured by the standing pass, which parses every transcript anyway.
  const line = (o: Parameters<typeof analysisBlock>[0]) => analysisBlock(o).join(' | ');

  it('shrinks when the queue is small, even with many sessions', () => {
    const many = line({ total: 30, read: 0, unread: 28, queueTokens: 20_000 });
    const few = line({ total: 30, read: 0, unread: 2, queueTokens: 120_000 });
    expect(many).toMatch(/seconds|1 minute/);
    expect(few, 'two big sessions outweigh twenty-eight small ones').toMatch(/minutes/);
  });

  it('overestimates rather than under, with nothing measured yet', () => {
    // Before the standing pass has run there are no sizes, so each unread
    // session is assumed to be a full-budget packet. Wrong, and wrong in the
    // direction that does not promise a reader something it cannot deliver.
    const blind = line({ total: 28, read: 0, unread: 28 });
    const measured = line({ total: 28, read: 0, unread: 28, queueTokens: 217_567 });
    expect(blind).not.toBe(measured);
    expect(blind).toMatch(/28 minutes/);
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
  // `measuredCallMs` took a median of durations regardless of what they read.
  // The first three recorded were ~3s each on packets of ~1,700 tokens, which
  // says nothing about a 60,000-token one — and multiplying it across the
  // queue is how the surface came to claim "about 3 minutes" for 217,567
  // tokens of work.
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
