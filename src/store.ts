/**
 * The SQLite store. A database because concurrent writers lost updates as whole-state JSON;
 * `node:sqlite` because it is built in and the plugin has no install step. The only module that imports it.
 */
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as sqlite from 'node:sqlite';

import { SCHEMA } from './schema.ts';

/** Prefer `Database`; `DatabaseSync` is the deprecated alias older Node ships. */
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

const STORE_FILE = 'store.db';

/** Kept separate so the one migration below can rebuild exactly this. */
const RUN_DDL = `
CREATE TABLE IF NOT EXISTS run (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  status      TEXT,
  -- Which session the pass is reading. Without it a reader can say that
  -- something is happening but not whether it is happening to them, which is
  -- the only version of the question anyone actually asks.
  session_id  TEXT,
  -- Real elapsed time from the harness's own envelope, so an estimate can be
  -- measured rather than asserted. JUDGE_SECONDS_PER_CALL is three runs
  -- hand-copied into a constant; this is every run, continuously.
  duration_ms INTEGER,
  -- How much the pass actually read. Without it, duration is uninterpretable:
  -- the first three recorded runs took ~3s each and were reading packets of
  -- ~1,700 tokens, which says nothing about a 60,000-token one. A median over
  -- them produced an ETA calibrated on the smallest quartile of the queue.
  packet_tokens INTEGER,
  -- Findings the lookback gate dropped as suggestions or unverified sources.
  gated INTEGER
);
`;

/** Extracted so the one migration below can rebuild exactly this. */
const SESSION_DDL = `
CREATE TABLE IF NOT EXISTS session (
  id            TEXT PRIMARY KEY,
  project       TEXT NOT NULL,
  first_ts      TEXT,
  last_ts       TEXT,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  gone          INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL,
  packet_tokens INTEGER
);
`;

/** Sessions no packet can hold, so the drain stops returning to them. */
const SKIPPED_DDL = `
CREATE TABLE IF NOT EXISTS skipped (
  session_id TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,
  at         TEXT NOT NULL
);
`;

/** How far into an oversized turn the judge has read; the byte ledger can only say "up to turn k". */
const PART_DDL = `
CREATE TABLE IF NOT EXISTS part_cursor (
  session_id TEXT PRIMARY KEY,
  seq        INTEGER NOT NULL,
  chars      INTEGER NOT NULL,
  at         TEXT NOT NULL
);
`;

/**
 * What the person set aside. A dismissal hides, never deletes (rule findings are re-derived each pass).
 * Key by scope: `subject` = subjectId, `finding` = per-session id, `judged` = judge occurrence id.
 * Ids and enums only, no transcript content.
 */
const DISMISSAL_DDL = `
CREATE TABLE IF NOT EXISTS dismissal (
  key       TEXT PRIMARY KEY,
  scope     TEXT NOT NULL,   -- 'subject' | 'finding' | 'judged'
  dimension TEXT NOT NULL,
  reason    TEXT NOT NULL,   -- 'wrong' | 'suggestion' | 'noise' | 'cleared'
  at        TEXT NOT NULL
);
`;

/** The person's verdict on a finding: the gold set judge accuracy is measured against. Ids and enums only. */
const LABEL_DDL = `
CREATE TABLE IF NOT EXISTS label (
  key       TEXT PRIMARY KEY,
  dimension TEXT NOT NULL,
  verdict   TEXT NOT NULL,   -- 'mistake' | 'suggestion' | 'wrong'
  at        TEXT NOT NULL
);
`;

/**
 * One `occurrence` row is one anchored instance; a finding is a GROUP BY, not a table.
 * `ledger` (progress) and `spend` (cost) are separate, so a failed stage re-bills rather than losing results.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  id            TEXT PRIMARY KEY,
  project       TEXT NOT NULL,
  first_ts      TEXT,
  last_ts       TEXT,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  gone          INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL,
  -- What the judge will actually have to read, measured rather than guessed.
  --
  -- Nothing cheap predicts it. Measured across 29 real sessions, tokens per
  -- KB spans 1.5 to 9.4, and tokens against event count is not even
  -- monotonic: 6,067 events render to 66,196 tokens while 7,013 render to
  -- 55,691, because consecutive same-role turns merge.
  --
  -- So it is computed instead of modelled, by the pass that already parses
  -- every transcript: +195ms on top of 1,442ms, and free of model tokens.
  packet_tokens INTEGER
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
  at          TEXT NOT NULL,
  secondary_dimensions TEXT       -- judge only: JSON array of other kinds it also is
);
CREATE INDEX IF NOT EXISTS occurrence_session ON occurrence(session_id);
CREATE INDEX IF NOT EXISTS occurrence_dim     ON occurrence(dimension, subject);

-- What an occurrence points at. The two tiers anchor differently and the
-- column names say so rather than pretending otherwise:
--
--   rule tier   a uuid, per D24 - a seq is a position on the active path and
--               moves when a rewind changes which branch is live
--   judge tier  a turn number, because that is what the model cites, and its
--               quote is what actually validates the citation
--
-- Storing a turn in a column named uuid would have been a quiet lie.
CREATE TABLE IF NOT EXISTS evidence (
  occurrence_id TEXT NOT NULL,
  anchor        TEXT NOT NULL,   -- a uuid or a turn number, per kind
  kind          TEXT NOT NULL,   -- 'uuid' | 'turn'
  quote         TEXT,
  PRIMARY KEY (occurrence_id, anchor)
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
${RUN_DDL}
${SKIPPED_DDL}
${PART_DDL}
${DISMISSAL_DDL}
${LABEL_DDL}
`;

/** Open the store, creating it if needed. WAL lets readers read during a write; busy_timeout waits rather than throws. */
export function openStore(archive: string): Db {
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  const file = join(archive, STORE_FILE);
  const db = new DatabaseCtor(file, { timeout: 5000 });

  // node:sqlite takes no mode option and follows the umask, so set 0600; -wal and -shm follow it.
  // Wrapped: Principle Zero outranks a tightened mode.
  try {
    chmodSync(file, 0o600);
  } catch {
    // A mode we could not set is not a reason to fail a session.
  }

  // Connection settings. Neither takes a lock.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');

  // DDL takes a write lock, so a plain open must not run it; check existence with a read.
  // Hand-written migrations for `run` and `session`: add columns, rebuild only when empty.
  try {
    const cols = (db.prepare('PRAGMA table_info(run)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    // Missing entirely, or present with the old shape.
    if (cols.length === 0) {
      db.exec(RUN_DDL);
    } else if (!cols.includes('session_id') || !cols.includes('packet_tokens')) {
      // Add columns first: the drop below is lossless only on an empty table.
      for (const col of ['session_id TEXT', 'duration_ms INTEGER', 'packet_tokens INTEGER']) {
        const name = col.split(' ')[0] as string;
        if (cols.includes(name)) continue;
        try {
          db.exec(`ALTER TABLE run ADD COLUMN ${col}`);
        } catch {
          // Already there, or unrepairable; the drop below covers an empty table.
        }
      }
      const held = (db.prepare('SELECT COUNT(*) c FROM run').get() as { c: number }).c;
      if (held === 0) {
        // Recreated here: the DDL below runs only for an uninitialised store.
        db.exec('DROP TABLE run');
        db.exec(RUN_DDL);
      }
    }
    // `gated` came later still: added in place, never a rebuild.
    const rcols = (db.prepare('PRAGMA table_info(run)').all() as { name: string }[]).map((c) => c.name);
    if (rcols.length > 0 && !rcols.includes('gated')) {
      try {
        db.exec('ALTER TABLE run ADD COLUMN gated INTEGER');
      } catch {
        // Already there.
      }
    }
    const ocols = (db.prepare('PRAGMA table_info(occurrence)').all() as { name: string }[]).map((c) => c.name);
    if (ocols.length > 0 && !ocols.includes('secondary_dimensions')) {
      try {
        db.exec('ALTER TABLE occurrence ADD COLUMN secondary_dimensions TEXT');
      } catch {
        // Already there.
      }
    }
    // Added after `run`, so an existing store has neither.
    db.exec(SKIPPED_DDL);
    db.exec(PART_DDL);
    db.exec(DISMISSAL_DDL);
    db.exec(LABEL_DDL);

    // `session` gained `packet_tokens` the same way.
    const scols = (db.prepare('PRAGMA table_info(session)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    if (scols.length === 0) {
      db.exec(SESSION_DDL);
    } else if (!scols.includes('packet_tokens')) {
      const held = (db.prepare('SELECT COUNT(*) c FROM session').get() as { c: number }).c;
      if (held === 0) {
        db.exec('DROP TABLE session');
        db.exec(SESSION_DDL);
      }
    }
  } catch {
    // A store we cannot inspect is one `initialised` will rebuild below.
  }

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
 * `BEGIN IMMEDIATE` takes the write lock up front, so two writers cannot both read then lose an update.
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

/** Record what a model call cost. Deliberately outside the findings' transaction: we paid either way. */
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

/** Advance how far a session has been analysed. `MAX`, so a resumed pass never moves it backwards. */
export function advanceLedger(db: Db, sessionId: string, bytes: number): void {
  db.prepare(
    `INSERT INTO ledger(session_id, judged_bytes, at) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE
       SET judged_bytes = MAX(judged_bytes, excluded.judged_bytes),
           at = excluded.at`,
  ).run(sessionId, bytes, new Date().toISOString());
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
  /** Judge only: other kinds the finding also is. */
  secondaryDimensions?: string[];
};

/** Record occurrences. Ids are content hashes, so upserting makes a retried pass idempotent. */
export function putOccurrences(db: Db, rows: OccurrenceRow[]): void {
  const put = db.prepare(
    `INSERT INTO occurrence
       (id, session_id, dimension, tier, subject, anchor_uuid, confidence, reason, at, secondary_dimensions)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       confidence = excluded.confidence,
       reason     = excluded.reason,
       at         = excluded.at,
       secondary_dimensions = excluded.secondary_dimensions`,
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
      r.secondaryDimensions === undefined || r.secondaryDimensions.length === 0 ? null : JSON.stringify(r.secondaryDimensions),
    );
  }
}

/** The turns a finding cites. One row per turn, keyed by the occurrence. */
export function putEvidence(
  db: Db,
  rows: { occurrenceId: string; anchor: string; kind: 'uuid' | 'turn' | 'established'; quote?: string }[],
): void {
  const put = db.prepare(
    `INSERT INTO evidence(occurrence_id, anchor, kind, quote) VALUES (?, ?, ?, ?)
     ON CONFLICT(occurrence_id, anchor) DO UPDATE SET quote = excluded.quote`,
  );
  for (const r of rows) put.run(r.occurrenceId, r.anchor, r.kind, r.quote ?? null);
}

/** Record that a pass has started and which session it is reading. */
export function startRun(db: Db, kind: string, sessionId?: string): string {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    'INSERT INTO run(id, kind, started_at, status, session_id) VALUES (?, ?, ?, ?, ?)',
  ).run(id, kind, new Date().toISOString(), 'running', sessionId ?? null);
  return id;
}

/** Close a run. Called from a `finally`, so a crash still leaves a record. */
export function endRun(
  db: Db,
  id: string,
  status: string,
  durationMs?: number,
  packetTokens?: number,
  gated?: number,
): void {
  db.prepare(
    'UPDATE run SET ended_at = ?, status = ?, duration_ms = ?, packet_tokens = ?, gated = ? WHERE id = ?',
  ).run(new Date().toISOString(), status, durationMs ?? null, packetTokens ?? null, gated ?? null, id);
}

/** The pass in flight, if any. Bounded by `staleMs`: a killed process leaves its row open. */
export function currentRun(
  db: Db,
  staleMs: number,
  now = Date.now(),
): { id: string; kind: string; sessionId?: string; startedAt: string; elapsedMs: number } | undefined {
  const row = db
    .prepare("SELECT id, kind, started_at, session_id FROM run WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1")
    .get() as { id: string; kind: string; started_at: string; session_id: string | null } | undefined;
  if (row === undefined) return undefined;
  const started = Date.parse(row.started_at);
  if (!Number.isFinite(started)) return undefined;
  const elapsedMs = now - started;
  if (elapsedMs > staleMs) return undefined;
  return {
    id: row.id,
    kind: row.kind,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    startedAt: row.started_at,
    elapsedMs,
  };
}

/** Median duration of recent completed runs; `undefined` until there are `minRuns`. */
export function measuredCallMs(db: Db, minRuns = 3): number | undefined {
  const rows = db
    .prepare('SELECT duration_ms FROM run WHERE duration_ms IS NOT NULL ORDER BY started_at DESC LIMIT 20')
    .all() as { duration_ms: number }[];
  if (rows.length < minRuns) return undefined;
  const sorted = rows.map((r) => r.duration_ms).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Median ms per packet token over recent runs; duration means nothing without the size it read.
 * `undefined` until runs of at least two different sizes exist.
 */
export function measuredMsPerToken(db: Db, minRuns = 2): number | undefined {
  const rows = db
    .prepare(
      'SELECT duration_ms, packet_tokens FROM run ' +
        'WHERE duration_ms IS NOT NULL AND packet_tokens IS NOT NULL AND packet_tokens > 0 ' +
        'ORDER BY started_at DESC LIMIT 20',
    )
    .all() as { duration_ms: number; packet_tokens: number }[];
  if (rows.length < minRuns) return undefined;
  if (new Set(rows.map((r) => r.packet_tokens)).size < 2) return undefined;

  const rates = rows.map((r) => r.duration_ms / r.packet_tokens).sort((a, b) => a - b);
  return rates[Math.floor(rates.length / 2)];
}

/** Mark a session no packet can hold. Not a breaker failure: the breaker is for transient faults. */
export function markSkipped(db: Db, sessionId: string, reason: string): void {
  db.prepare(
    'INSERT INTO skipped(session_id, reason, at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(session_id) DO UPDATE SET reason = excluded.reason, at = excluded.at',
  ).run(sessionId, reason, new Date().toISOString());
}

/** A session that has been read is not skipped, whatever an older pass decided. */
export function unmarkSkipped(db: Db, sessionId: string): void {
  db.prepare('DELETE FROM skipped WHERE session_id = ?').run(sessionId);
}

/** Where to resume inside an oversized turn; `undefined` clears it. */
export function setPartCursor(
  db: Db,
  sessionId: string,
  cursor: { seq: number; chars: number } | undefined,
): void {
  if (cursor === undefined) {
    db.prepare('DELETE FROM part_cursor WHERE session_id = ?').run(sessionId);
    return;
  }
  db.prepare(
    'INSERT INTO part_cursor(session_id, seq, chars, at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(session_id) DO UPDATE SET seq = excluded.seq, chars = excluded.chars, at = excluded.at',
  ).run(sessionId, cursor.seq, cursor.chars, new Date().toISOString());
}

export function partCursors(db: Db): Record<string, { seq: number; chars: number }> {
  const out: Record<string, { seq: number; chars: number }> = {};
  for (const r of db.prepare('SELECT session_id, seq, chars FROM part_cursor').all()) {
    out[String(r['session_id'])] = { seq: Number(r['seq']), chars: Number(r['chars']) };
  }
  return out;
}

/** Sessions the drain should pass over, with why. */
export function skippedSessions(db: Db): { sessionId: string; reason: string }[] {
  return (
    db.prepare('SELECT session_id, reason FROM skipped').all() as {
      session_id: string;
      reason: string;
    }[]
  ).map((r) => ({ sessionId: r.session_id, reason: r.reason }));
}

/** What a session will cost the judge to read, written by the standing pass (no model tokens). */
export type SessionCostRow = {
  id: string;
  project: string;
  sizeBytes: number;
  packetTokens: number;
  /** The session's own span, from its events. Absent when no event carries a time. */
  firstTs?: string;
  lastTs?: string;
};

export function putSessionCost(db: Db, rows: SessionCostRow[]): void {
  // Overwrite the span, not widen it: the latest parse of a live session is the one to trust.
  const put = db.prepare(
    'INSERT INTO session(id, project, first_ts, last_ts, size_bytes, updated_at, packet_tokens) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ' +
      'first_ts = excluded.first_ts, last_ts = excluded.last_ts, ' +
      'size_bytes = excluded.size_bytes, packet_tokens = excluded.packet_tokens, ' +
      'updated_at = excluded.updated_at',
  );
  const at = new Date().toISOString();
  for (const r of rows) {
    put.run(r.id, r.project, r.firstTs ?? null, r.lastTs ?? null, r.sizeBytes, at, r.packetTokens);
  }
}

/** What each session will cost, for sizing the queue. */
export function sessionCosts(db: Db): Map<string, number> {
  const rows = db
    .prepare('SELECT id, packet_tokens FROM session WHERE packet_tokens IS NOT NULL')
    .all() as { id: string; packet_tokens: number }[];
  return new Map(rows.map((r) => [r.id, r.packet_tokens]));
}

export type DismissScope = 'subject' | 'finding' | 'judged';
/** `wrong` leaves every count; `suggestion`, `noise` and `cleared` are hidden but still counted. */
export type DismissReason = 'wrong' | 'suggestion' | 'noise' | 'cleared';

export type Verdict = 'mistake' | 'suggestion' | 'wrong';
export type LabelRow = { key: string; dimension: string; verdict: Verdict; at: string };

/** Record a verdict; a later one replaces an earlier. */
export function putLabel(db: Db, r: LabelRow): void {
  db.prepare(
    'INSERT INTO label(key, dimension, verdict, at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET verdict = excluded.verdict, at = excluded.at',
  ).run(r.key, r.dimension, r.verdict, r.at);
}

export function readLabels(db: Db): LabelRow[] {
  return (db.prepare('SELECT key, dimension, verdict, at FROM label ORDER BY at').all() as LabelRow[]).map((r) => ({ ...r }));
}

export type DismissalRow = {
  key: string;
  scope: DismissScope;
  dimension: string;
  reason: DismissReason;
  at: string;
};

/** Record dismissals. Re-dismissing a key keeps the newer, more specific reason. */
export function putDismissals(db: Db, rows: DismissalRow[]): void {
  const put = db.prepare(
    'INSERT INTO dismissal(key, scope, dimension, reason, at) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET reason = excluded.reason, at = excluded.at',
  );
  for (const r of rows) put.run(r.key, r.scope, r.dimension, r.reason, r.at);
}

/** Undo. Returns how many were actually there, so "restored 0" is not a lie. */
export function removeDismissals(db: Db, keys: string[]): number {
  const del = db.prepare('DELETE FROM dismissal WHERE key = ?');
  let n = 0;
  for (const k of keys) {
    const before = db.prepare('SELECT 1 FROM dismissal WHERE key = ?').get(k);
    if (before === undefined) continue;
    del.run(k);
    n += 1;
  }
  return n;
}

export function readDismissals(db: Db): DismissalRow[] {
  return (
    db.prepare('SELECT key, scope, dimension, reason, at FROM dismissal ORDER BY at DESC').all() as {
      key: string;
      scope: string;
      dimension: string;
      reason: string;
      at: string;
    }[]
  ).map((r) => ({
    key: r.key,
    scope: r.scope as DismissScope,
    dimension: r.dimension,
    reason: r.reason as DismissReason,
    at: r.at,
  }));
}

/** Open the store, run `fn`, close it. Any failure reads as `undefined`. */
export function withStore<T>(archive: string, fn: (db: Db) => T): T | undefined {
  try {
    const db = openStore(archive);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}
