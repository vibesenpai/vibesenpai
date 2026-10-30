/** The automatic pass's spend limits, and the spend records they count from. */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  addSpend, endRun, openStore, readCatchUpFrom, readSpend, spendSince, startRun, tokensSince,
} from '../src/store.ts';
import {
  batchCost, budgetLeft, catchUpCutoff, catchUpFrom, eligible, limited, LIMITS_ENV, startOfDay, withinBudget,
} from '../src/judge/limits.ts';
import { DEFAULT_SETTINGS, emptyState } from '../src/judge/state.ts';
import { jobsFor } from '../src/jobs.ts';
import { dollars } from '../src/format.ts';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'as-limits-'));

describe('the defaults', () => {
  it('are 2M tokens a day and a 200-session catch-up', () => {
    expect(DEFAULT_SETTINGS.dailyTokens).toBe(2_000_000);
    expect(DEFAULT_SETTINGS.catchUp).toBe(200);
  });

  it('apply only when the Stop hook asks', () => {
    expect(limited({})).toBe(false);
    expect(limited({ [LIMITS_ENV]: '1' })).toBe(true);
  });
});

describe('the daily budget', () => {
  it('sends the leading batches that fit and holds the rest', () => {
    expect(withinBudget([10, 20, 30], (n) => n, 35)).toEqual([10, 20]);
    expect(withinBudget([40, 1], (n) => n, 35), 'never skips ahead to a smaller one').toEqual([]);
    expect(withinBudget([10], (n) => n, Infinity)).toEqual([10]);
  });

  it('prices a batch at its packet plus two calls of overhead', () => {
    expect(batchCost(1000)).toBe(1000 + 52_000);
  });

  it('counts today from runs, in and out, and not yesterday', () => {
    const db = openStore(scratch());
    endRun(db, startRun(db, 'judge'), 'done', 1, 1, undefined, { calls: 2, tokensIn: 300_000, tokensOut: 20_000, usd: 0.4 });
    db.prepare("UPDATE run SET started_at = '2000-01-01T00:00:00.000Z' WHERE calls = 2").run();
    endRun(db, startRun(db, 'judge'), 'done', 1, 1, undefined, { calls: 1, tokensIn: 100_000, tokensOut: 5_000, usd: 0.1 });
    expect(tokensSince(db, startOfDay())).toBe(105_000);
    expect(budgetLeft(db, 2_000_000)).toBe(1_895_000);
    db.close();
  });

  it('starts at local midnight', () => {
    const d = new Date(2026, 9, 29, 15, 30);
    expect(new Date(startOfDay(d)).getHours()).toBe(0);
    expect(new Date(startOfDay(d)).getDate()).toBe(29);
  });
});

describe('the catch-up', () => {
  const sessions = [
    { id: 'a', mtimeMs: 100 },
    { id: 'b', mtimeMs: 200 },
    { id: 'c', mtimeMs: 300 },
    { id: 'd', mtimeMs: 400 },
  ];

  it('reaches back to the nth newest never-read session', () => {
    expect(catchUpCutoff(emptyState(), sessions, 2)).toBe(300);
    expect(catchUpCutoff(emptyState(), sessions, 4), 'no more than n: everything').toBe(0);
  });

  it('keeps sessions already started, whatever their age', () => {
    const state = { ...emptyState(), ledger: { a: 10 } };
    expect(eligible(state, sessions, 300).map((s) => s.id)).toEqual(['a', 'c', 'd']);
  });

  it('is fixed once, so later passes never reach further back', () => {
    const dir = scratch();
    const state = { ...emptyState(), settings: { ...DEFAULT_SETTINGS, catchUp: 2 } };
    expect(catchUpFrom(dir, state, sessions, false)).toBe(300);
    expect(withStoreRead(dir), 'a hook only reads').toBeUndefined();
    expect(catchUpFrom(dir, state, sessions, true)).toBe(300);
    // After the catch-up the old unread ones would rank newest; the stored cutoff still holds them back.
    const later = { ...state, ledger: { c: 1, d: 1 } };
    expect(catchUpFrom(dir, later, sessions, true)).toBe(300);
    expect(eligible(later, sessions, 300).map((s) => s.id)).toEqual(['c', 'd']);
  });
});

function withStoreRead(dir: string): number | undefined {
  const db = openStore(dir);
  try {
    return readCatchUpFrom(db);
  } finally {
    db.close();
  }
}

describe('spend carries dollars', () => {
  it('accumulates the harness figure in micro-dollars', () => {
    const db = openStore(scratch());
    addSpend(db, { calls: 1, tokensIn: 10, tokensOut: 1, usd: 0.25 });
    addSpend(db, { calls: 1, tokensIn: 10, tokensOut: 1, usd: 0.5 });
    expect(readSpend(db)).toEqual({ calls: 2, tokensIn: 20, tokensOut: 2, usdMicros: 750_000 });
    db.close();
  });

  it('says from when, if calls were recorded before dollars were', () => {
    const db = openStore(scratch());
    addSpend(db, { calls: 3, tokensIn: 10 });
    addSpend(db, { calls: 1, usd: 0.1 });
    expect(readSpend(db).usdSince).toBeDefined();
    expect(spendSince(db, '2000-01-01T00:00:00.000Z').usdSince, 'a window that starts earlier is partial').toBeDefined();
    db.close();
  });

  it('formats a cent and below', () => {
    expect(dollars(1_870_000)).toBe('$1.87');
    expect(dollars(5_000)).toBe('< $0.01');
  });

  it('adds the run columns in place on an older store', () => {
    const dir = scratch();
    const raw = new DatabaseSync(join(dir, 'store.db'));
    raw.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE run (id TEXT PRIMARY KEY, kind TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, status TEXT,
        session_id TEXT, duration_ms INTEGER, packet_tokens INTEGER, gated INTEGER);
      INSERT INTO run(id, kind, started_at) VALUES ('old', 'judge', '2026-01-01T00:00:00.000Z');`);
    raw.close();
    const db = openStore(dir);
    const cols = (db.prepare('PRAGMA table_info(run)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['calls', 'tokens_in', 'tokens_out', 'usd_micros']));
    expect((db.prepare('SELECT COUNT(*) c FROM run').get() as { c: number }).c, 'kept, not rebuilt').toBe(1);
    db.close();
  });
});

describe('only the automatic pass is held to them', () => {
  // One unread session too small to be due on cadence, so only the backlog makes the judge due.
  const setup = () => {
    const archive = scratch();
    const sources = mkdtempSync(join(tmpdir(), 'as-src-'));
    mkdirSync(join(sources, 'p'));
    writeFileSync(join(sources, 'p', 'aaaa.jsonl'), '{}\n');
    return { archive, sources: [sources] };
  };
  const due = (config: { archive: string; sources: string[] }, limits: boolean): boolean =>
    jobsFor(config, { judge: true, limits }).find((j) => j.name === 'judge')?.isDue() ?? false;

  it('stops the Stop hook pass once the day is spent; an explicit run still goes', () => {
    const config = setup();
    expect(due(config, true)).toBe(true);
    const db = openStore(config.archive);
    endRun(db, startRun(db, 'judge'), 'done', 1, 1, undefined, { calls: 1, tokensIn: 1_990_000, tokensOut: 0 });
    db.close();
    expect(due(config, true)).toBe(false);
    expect(due(config, false)).toBe(true);
  });
});

describe('a window says where its figures start', () => {
  it('when older runs predate the spend columns', () => {
    const db = openStore(scratch());
    const old = startRun(db, 'judge');
    endRun(db, old, 'done', 1, 1);
    db.prepare("UPDATE run SET started_at = '2026-10-25T00:00:00.000Z' WHERE id = ?").run(old);
    expect(spendSince(db, '2026-10-22T00:00:00.000Z').since, 'nothing tracked yet').toBeDefined();
    endRun(db, startRun(db, 'judge'), 'done', 1, 1, undefined, { calls: 1, tokensIn: 5, tokensOut: 1 });
    const w = spendSince(db, '2026-10-22T00:00:00.000Z');
    expect(w.calls).toBe(1);
    expect(w.since! > '2026-10-25T00:00:00.000Z').toBe(true);
    db.close();
  });

  it('not on a store that recorded every run', () => {
    const db = openStore(scratch());
    endRun(db, startRun(db, 'judge'), 'done', 1, 1, undefined, { calls: 1, tokensIn: 5, tokensOut: 1 });
    expect(spendSince(db, '2026-10-22T00:00:00.000Z').since).toBeUndefined();
    db.close();
  });
});
