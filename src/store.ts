/**
 * The store.
 *
 * ── Why a database at all ──────────────────────────────────────────────────
 *
 * Not size. The flat files this replaces total ~25 KB, and a heavy user reaches
 * a few megabytes — JSON is fine at that scale and would stay fine.
 *
 * It is that **every writer read-modify-writes whole state**, so the last write
 * wins and the others are lost. Measured on the real store:
 *
 *     two writers, each adding one ledger entry
 *     before: 12     after: 13     expected: 14
 *
 * That costs money and consent, not just tidiness:
 *
 * - A session marked judged by one writer is **un-marked** by another, so it is
 *   judged again. That is the double-spend this project has already patched
 *   once, with a marker that narrows the window rather than closing it.
 * - `judge --disable --apply` during a pass is **silently undone**: the pass
 *   holds a copy taken before you disabled it and writes the whole object back.
 *   A user turns the model off and the tool turns it back on.
 * - Token totals are read-modify-write too, so the spend figure we show is an
 *   under-count.
 *
 * ── Why SQLite, and why not DuckDB ─────────────────────────────────────────
 *
 * Workload shape, not availability. SQLite is **single-writer, multi-reader,
 * transactional**, which is exactly this pipeline: one detached producer and
 * several instant readers. DuckDB is faster at columnar scans over large data —
 * meaningless at this size — and is optimised for a single process, which is
 * the thing we need least. It is also a tens-of-megabyte native binary, and
 * **the plugin ships as a git clone with no `node_modules` and no install
 * step**, so anything needing compilation breaks the install story.
 *
 * `node:sqlite` is built in. `PLAN.md` chose it long before this file existed,
 * RC status and all, with `better-sqlite3` named as the fallback.
 *
 * ── Why this is the only module that imports it ────────────────────────────
 *
 * The module is a release candidate, and `DatabaseSync` is already a deprecated
 * alias for `Database`. One import site means one place to change when that
 * lands, and one place to swap for `better-sqlite3` if the RC API bites.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as sqlite from 'node:sqlite';

import { SCHEMA } from './schema.ts';

/**
 * `Database` is the current name; `DatabaseSync` is the deprecated alias this
 * Node still ships. Prefer the new one so the rename is a no-op when it lands.
 */
type Ctor = new (path: string, options?: { timeout?: number }) => Db;
const DatabaseCtor = ((sqlite as Record<string, unknown>)['Database'] ??
  (sqlite as Record<string, unknown>)['DatabaseSync']) as unknown as Ctor;

/** The surface this module uses. Narrow on purpose — it is the swap boundary. */
export type Db = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
  close(): void;
};

export const STORE_FILE = 'store.db';

/**
 * The schema.
 *
 * ── The grain, declared ────────────────────────────────────────────────────
 *
 * One row of `occurrence` is **one anchored instance** — the atomic fact. Not
 * a grouped finding, which is what the file it replaces stored:
 *
 *     edit_retry: 4 occurrences across 2 sessions, 3 files
 *       but only ONE subject was kept
 *
 * Two of those three files were simply gone, because the aggregation had been
 * frozen into storage and could not be asked a different question. Storing the
 * atomic row makes "top subject", "across N files" and per-session counts all
 * queries, and none of them privileged over the others.
 *
 * `finding` is deliberately **not a table**. It is a `GROUP BY dimension,
 * subject`, which is what a finding has always meant.
 *
 * ── Progress and cost are separate, and that is the point ──────────────────
 *
 * `ledger` says *we have results for these bytes*. `spend` says *we paid*.
 * Coupling them is the documented pitfall of incremental pipelines, and this
 * project hit it: the ledger advances after stage A, so a stage-B failure
 * loses those episodes permanently — the code says so in a comment and accepts
 * it. Separated, a stage-B failure re-bills rather than discarding results
 * already paid for, which for an evidence tool is the right way round.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  id         TEXT PRIMARY KEY,
  project    TEXT NOT NULL,
  first_ts   TEXT,
  last_ts    TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  gone       INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- The fact table, at atomic grain: one anchored occurrence.
CREATE TABLE IF NOT EXISTS occurrence (
  id          TEXT PRIMARY KEY,   -- content hash, so a re-run is idempotent
  session_id  TEXT NOT NULL,
  dimension   TEXT NOT NULL,
  tier        TEXT NOT NULL,      -- 'rule' | 'judge', never collapsed
  subject     TEXT NOT NULL,
  anchor_uuid TEXT,               -- uuid, never seq (D24)
  confidence  TEXT NOT NULL,
  reason      TEXT,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS occurrence_session ON occurrence(session_id);
CREATE INDEX IF NOT EXISTS occurrence_dim     ON occurrence(dimension, subject);

CREATE TABLE IF NOT EXISTS evidence (
  occurrence_id TEXT NOT NULL,
  uuid          TEXT NOT NULL,
  quote         TEXT,
  PRIMARY KEY (occurrence_id, uuid)
);

-- How far we have results. Advances only with the data it describes.
CREATE TABLE IF NOT EXISTS ledger (
  session_id   TEXT PRIMARY KEY,
  judged_bytes INTEGER NOT NULL,
  at           TEXT NOT NULL
);

-- What we paid. Written when a call returns, whatever happened afterwards.
CREATE TABLE IF NOT EXISTS spend (
  key TEXT PRIMARY KEY,
  n   INTEGER NOT NULL DEFAULT 0
);

-- Is analysis in flight, did it finish, what did it cost. Answered directly
-- rather than inferred, which is what the session-start line needs.
CREATE TABLE IF NOT EXISTS run (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  status     TEXT
);
`;

/**
 * Open the store, creating it if needed.
 *
 * `WAL` is what lets a reader read while the producer writes — without it the
 * whole pipeline serialises on the slowest thing in it. `busy_timeout` means a
 * writer waits for a lock instead of throwing, which matters because the
 * alternative is a hook that fails for a reason the user cannot act on.
 */
export function openStore(archive: string): Db {
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  const db = new DatabaseCtor(join(archive, STORE_FILE), { timeout: 5000 });

  // Connection settings. Neither takes a lock.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');

  // ── Only initialise when it is actually needed ──────────────────────────
  //
  // This used to run the DDL on every open, which looks harmless — the
  // statements are `IF NOT EXISTS` — and is not: **DDL takes a write lock**,
  // so merely opening the store to read it would block behind a producer's
  // open transaction. A test caught it as `database is locked` after the full
  // five-second busy timeout, which is exactly the failure a reader must never
  // have.
  //
  // So the existence check is a read, and the write path runs once per store.
  if (!initialised(db)) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(DDL);
    const put = db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)');
    put.run('schema_version', String(SCHEMA.store));
    put.run('created_at', new Date().toISOString());
  }
  return db;
}

/** Does this file already hold our schema? A read, so it cannot block. */
function initialised(db: Db): boolean {
  try {
    return (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'`)
        .get() !== undefined
    );
  } catch {
    return false;
  }
}

/**
 * Run `fn` inside one transaction, rolling back if it throws.
 *
 * `BEGIN IMMEDIATE` takes the write lock up front rather than on first write.
 * Deferred, two writers can both start, both read, and one then fails to
 * upgrade — which is the lost update this store exists to prevent, reproduced
 * with extra steps.
 */
export function transact<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // A failed rollback must not mask the error that caused it.
    }
    throw err;
  }
}

/**
 * Record what a model call cost.
 *
 * Deliberately **not** in the same transaction as the findings. We paid the
 * moment the call returned, and that is true whether or not anything
 * downstream succeeded. Making the spend conditional on success is how a tool
 * ends up under-reporting what it charged someone.
 */
export function addSpend(
  db: Db,
  delta: { calls?: number; tokensIn?: number; tokensOut?: number },
): void {
  const bump = db.prepare(
    `INSERT INTO spend(key, n) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET n = n + excluded.n`,
  );
  if (delta.calls) bump.run('calls', delta.calls);
  if (delta.tokensIn) bump.run('tokens_in', delta.tokensIn);
  if (delta.tokensOut) bump.run('tokens_out', delta.tokensOut);
}

export function readSpend(db: Db): { calls: number; tokensIn: number; tokensOut: number } {
  const rows = db.prepare('SELECT key, n FROM spend').all();
  const by = new Map(rows.map((r) => [String(r['key']), Number(r['n'])]));
  return {
    calls: by.get('calls') ?? 0,
    tokensIn: by.get('tokens_in') ?? 0,
    tokensOut: by.get('tokens_out') ?? 0,
  };
}

/**
 * Advance how far a session has been analysed.
 *
 * `MAX` rather than assignment, so a pass that resumed from an older offset
 * cannot drag the watermark backwards — which would re-bill bytes already
 * paid for and reported.
 */
export function advanceLedger(db: Db, sessionId: string, bytes: number): void {
  db.prepare(
    `INSERT INTO ledger(session_id, judged_bytes, at) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE
       SET judged_bytes = MAX(judged_bytes, excluded.judged_bytes),
           at = excluded.at`,
  ).run(sessionId, bytes, new Date().toISOString());
}

export function judgedBytes(db: Db, sessionId: string): number {
  const row = db.prepare('SELECT judged_bytes FROM ledger WHERE session_id = ?').get(sessionId);
  return row === undefined ? 0 : Number(row['judged_bytes']);
}

export type OccurrenceRow = {
  id: string;
  sessionId: string;
  dimension: string;
  tier: 'rule' | 'judge';
  subject: string;
  anchorUuid?: string;
  confidence: string;
  reason?: string;
  at: string;
};

/**
 * Record occurrences.
 *
 * `ON CONFLICT DO UPDATE` rather than `INSERT`, because the id is a content
 * hash: a retried pass produces identical ids and must not duplicate anything.
 * That is the whole of our idempotency, and it comes free from a key the
 * project already had.
 */
export function putOccurrences(db: Db, rows: OccurrenceRow[]): void {
  const put = db.prepare(
    `INSERT INTO occurrence
       (id, session_id, dimension, tier, subject, anchor_uuid, confidence, reason, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       confidence = excluded.confidence,
       reason     = excluded.reason,
       at         = excluded.at`,
  );
  for (const r of rows) {
    put.run(
      r.id,
      r.sessionId,
      r.dimension,
      r.tier,
      r.subject,
      r.anchorUuid ?? null,
      r.confidence,
      r.reason ?? null,
      r.at,
    );
  }
}

/** Occurrences for one session, newest first. */
export function occurrencesFor(db: Db, sessionId: string): OccurrenceRow[] {
  return db
    .prepare('SELECT * FROM occurrence WHERE session_id = ? ORDER BY at DESC')
    .all(sessionId)
    .map(toOccurrence);
}

/**
 * What a "finding" has always meant: a dimension and subject, with its count.
 *
 * A query rather than a table, which is what makes the other questions —
 * how many files, which session, how recent — answerable at all.
 */
export function groupedFindings(
  db: Db,
  opts: { tier?: 'rule' | 'judge' } = {},
): { dimension: string; subject: string; tier: string; occurrences: number; sessions: number }[] {
  const where = opts.tier === undefined ? '' : 'WHERE tier = ?';
  const params = opts.tier === undefined ? [] : [opts.tier];
  return db
    .prepare(
      `SELECT dimension, subject, tier,
              COUNT(*) AS occurrences,
              COUNT(DISTINCT session_id) AS sessions
       FROM occurrence ${where}
       GROUP BY dimension, subject, tier
       ORDER BY occurrences DESC`,
    )
    .all(...params)
    .map((r) => ({
      dimension: String(r['dimension']),
      subject: String(r['subject']),
      tier: String(r['tier']),
      occurrences: Number(r['occurrences']),
      sessions: Number(r['sessions']),
    }));
}

function toOccurrence(r: Record<string, unknown>): OccurrenceRow {
  return {
    id: String(r['id']),
    sessionId: String(r['session_id']),
    dimension: String(r['dimension']),
    tier: String(r['tier']) === 'judge' ? 'judge' : 'rule',
    subject: String(r['subject']),
    ...(r['anchor_uuid'] === null ? {} : { anchorUuid: String(r['anchor_uuid']) }),
    confidence: String(r['confidence']),
    ...(r['reason'] === null ? {} : { reason: String(r['reason']) }),
    at: String(r['at']),
  };
}
