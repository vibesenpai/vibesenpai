// The store's required behaviour, written as behaviour rather than SQLite specifics.
import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { occurrencesOf } from '../src/finding.ts';
import { stamp } from '../src/schema.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addSpend,
  advanceLedger,
  openStore,
  putOccurrences,
  putSessionCost,
  readSpend,
  transact,
  type Db,
  type OccurrenceRow,
} from '../src/store.ts';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'as-store-'));

// Read-back helpers, as plain SQL: the product reads these tables through other paths.
const judgedBytes = (db: Db, id: string): number =>
  Number(db.prepare('SELECT judged_bytes FROM ledger WHERE session_id = ?').get(id)?.['judged_bytes'] ?? 0);
const occurrencesFor = (db: Db, id: string): { id: string }[] =>
  db.prepare('SELECT id FROM occurrence WHERE session_id = ?').all(id).map((r) => ({ id: String(r['id']) }));
const grouped = (db: Db, tier?: string): { subject: string; occurrences: number; sessions: number }[] =>
  db
    .prepare(
      `SELECT subject, COUNT(*) AS occurrences, COUNT(DISTINCT session_id) AS sessions FROM occurrence
       ${tier === undefined ? '' : 'WHERE tier = ?'} GROUP BY dimension, subject, tier`,
    )
    .all(...(tier === undefined ? [] : [tier]))
    .map((r) => ({ subject: String(r['subject']), occurrences: Number(r['occurrences']), sessions: Number(r['sessions']) }));
const occ = (over: Partial<OccurrenceRow> = {}): OccurrenceRow => ({
  id: 'o1',
  sessionId: 's1',
  dimension: 'edit_retry',
  tier: 'rule',
  subject: 'src/api.ts',
  confidence: 'certain',
  at: '2026-10-23T00:00:00.000Z',
  ...over,
});

describe('writes do not clobber each other', () => {
  // Two read-modify-rename writers lost an update in the flat-file store (12 + 2 gave 13).
  it('keeps both writers’ ledger entries', () => {
    const dir = scratch();
    const a = openStore(dir);
    const b = openStore(dir);

    advanceLedger(a, 'session-one', 111);
    advanceLedger(b, 'session-two', 222);

    const read = openStore(dir);
    expect(judgedBytes(read, 'session-one')).toBe(111);
    expect(judgedBytes(read, 'session-two')).toBe(222);
    a.close();
    b.close();
    read.close();
  });

  it('keeps both writers’ findings', () => {
    // A pass's paid-for findings must not be overwritten by another pass.
    const dir = scratch();
    const a = openStore(dir);
    const b = openStore(dir);

    transact(a, () => putOccurrences(a, [occ({ id: 'from-a' })]));
    transact(b, () => putOccurrences(b, [occ({ id: 'from-b' })]));

    const ids = occurrencesFor(openStore(dir), 's1').map((o) => o.id).sort();
    expect(ids).toEqual(['from-a', 'from-b']);
    a.close();
    b.close();
  });

  it('never lets the watermark go backwards', () => {
    // The watermark never moves backwards: bytes behind it are already paid for and reported.
    const dir = scratch();
    const db = openStore(dir);
    advanceLedger(db, 's1', 5000);
    advanceLedger(db, 's1', 1000);
    expect(judgedBytes(db, 's1')).toBe(5000);
    db.close();
  });
});

describe('a retried pass cannot duplicate anything', () => {
  it('upserts on the content hash', () => {
    // Idempotent: the id hashes dimension, session and subject, so a re-run upserts the same rows.
    const dir = scratch();
    const db = openStore(dir);

    transact(db, () => putOccurrences(db, [occ(), occ({ id: 'o2', subject: 'b.ts' })]));
    transact(db, () => putOccurrences(db, [occ(), occ({ id: 'o2', subject: 'b.ts' })]));

    expect(occurrencesFor(db, 's1')).toHaveLength(2);
    db.close();
  });
});

describe('the grain is atomic', () => {
  it('keeps every subject, not just the worst one', () => {
    // Aggregation is a query, not frozen into storage, so every subject stays recoverable.
    const dir = scratch();
    const db = openStore(dir);
    transact(db, () =>
      putOccurrences(db, [
        occ({ id: '1', sessionId: 's1', subject: 'a.ts' }),
        occ({ id: '2', sessionId: 's1', subject: 'b.ts' }),
        occ({ id: '3', sessionId: 's2', subject: 'a.ts' }),
        occ({ id: '4', sessionId: 's2', subject: 'c.ts' }),
      ]),
    );

    const g = grouped(db);
    expect(g.map((x) => x.subject).sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(g.find((x) => x.subject === 'a.ts')).toMatchObject({
      occurrences: 2,
      sessions: 2,
    });
    db.close();
  });

  it('never collapses the two tiers', () => {
    // Rule and judge findings stay apart in the store too.
    const dir = scratch();
    const db = openStore(dir);
    transact(db, () =>
      putOccurrences(db, [
        occ({ id: 'r', tier: 'rule' }),
        occ({ id: 'j', tier: 'judge', dimension: 'misread_intent', confidence: 'likely' }),
      ]),
    );
    expect(grouped(db, 'rule')).toHaveLength(1);
    expect(grouped(db, 'judge')).toHaveLength(1);
    db.close();
  });
});

describe('spend and progress are separate facts', () => {
  it('records what was paid even when the work that followed failed', () => {
    // Spend is recorded when the call returns; the watermark advances only with results,
    // so a failed stage re-bills the bytes instead of silently dropping findings.
    const dir = scratch();
    const db = openStore(dir);

    addSpend(db, { calls: 1, tokensIn: 58_161, tokensOut: 3_962 });

    expect(() =>
      transact(db, () => {
        putOccurrences(db, [occ()]);
        advanceLedger(db, 's1', 9999);
        throw new Error('stage B failed');
      }),
    ).toThrow('stage B failed');

    expect(readSpend(db).calls, 'the call was paid for and must be recorded').toBe(1);
    expect(judgedBytes(db, 's1'), 'no results, so no progress').toBe(0);
    expect(occurrencesFor(db, 's1'), 'the transaction rolled back').toHaveLength(0);
    db.close();
  });

  it('accumulates spend rather than overwriting it', () => {
    const dir = scratch();
    const db = openStore(dir);
    addSpend(db, { calls: 1, tokensIn: 100 });
    addSpend(db, { calls: 1, tokensIn: 50 });
    expect(readSpend(db)).toMatchObject({ calls: 2, tokensIn: 150 });
    db.close();
  });
});

describe('a reader is never blocked by a writer', () => {
  it('reads consistent state while a transaction is open', () => {
    // WAL: a detached writer must not block an instant reader.
    const dir = scratch();
    const writer = openStore(dir);
    transact(writer, () => putOccurrences(writer, [occ({ id: 'committed' })]));

    writer.exec('BEGIN IMMEDIATE');
    putOccurrences(writer, [occ({ id: 'uncommitted' })]);

    const reader: Db = openStore(dir);
    const seen = occurrencesFor(reader, 's1').map((o) => o.id);
    expect(seen, 'the reader sees committed state and not the open write').toEqual(['committed']);

    writer.exec('ROLLBACK');
    reader.close();
    writer.close();
  });
});

describe('the rule tier is persisted at all', () => {
  // Rule findings persist one row per anchor; a rollup kept only one subject per dimension.
  it('maps a finding to one row per anchor', () => {
    const f = {
      ...stamp('finding'),
      id: 'f1',
      subjectId: 'sub1',
      dimension: 'edit_retry',
      subject: 'src/api.ts',
      sessionId: 's1',
      project: 'demo',
      evidence: [],
      anchors: [
        { uuid: 'u1', sessionId: 's1' },
        { uuid: 'u2', sessionId: 's1' },
      ],
      occurrences: 2,
      confidence: 'certain' as const,
      method: 'RULE' as const,
      requiresOutcome: false,
      polarity: 'negative' as const,
      denominator: 'per-edit' as const,
      firstSeen: '2026-10-23T00:00:00.000Z',
      lastSeen: '2026-10-23T01:00:00.000Z',
      reasons: { 'not-read-first': 2, 'string-not-found': 1 },
    } as unknown as Parameters<typeof occurrencesOf>[0][number];

    const rows = occurrencesOf([f]);
    expect(rows, 'one row per anchor, not one per finding').toHaveLength(2);
    expect(rows.map((r) => r.anchorUuid).sort()).toEqual(['u1', 'u2']);
    expect(rows[0]?.tier).toBe('rule');
    expect(rows[0]?.reason, 'the commonest harness reason labels the row').toBe('not-read-first');
  });

  it('gives each anchor a distinct, stable id', () => {
    // Distinct, or rows collapse on upsert; stable, or a re-run duplicates them.
    const base = {
      ...stamp('finding'),
      id: 'f1', subjectId: 's', dimension: 'edit_retry', subject: 'a.ts',
      sessionId: 's1', project: 'p', evidence: [], occurrences: 2,
      confidence: 'certain', method: 'RULE', requiresOutcome: false,
      polarity: 'negative', denominator: 'per-edit',
      firstSeen: 'x', lastSeen: 'y',
      anchors: [{ uuid: 'u1', sessionId: 's1' }, { uuid: 'u2', sessionId: 's1' }],
    } as unknown as Parameters<typeof occurrencesOf>[0][number];

    const first = occurrencesOf([base]).map((r) => r.id);
    const again = occurrencesOf([base]).map((r) => r.id);
    expect(new Set(first).size, 'ids must differ per anchor').toBe(2);
    expect(again, 'ids must be stable across runs').toEqual(first);
  });
});

describe('every archive writer uses a distinct temp path', () => {
  // A shared temp path let two concurrent writers race on rename (ENOENT).
  it('includes the pid', () => {
    for (const f of ['src/files.ts', 'src/catalog.ts', 'src/standing.ts', 'src/judge/state.ts', 'src/supervise/record.ts']) {
      const src = readFileSync(f, 'utf8');
      const temps = [...src.matchAll(/`\$\{[^`]*\}\.(?:\$\{process\.pid\}\.)?tmp`/g)].map((m) => m[0]);
      for (const t of temps) {
        expect(t, `${f} writes a temp path with no pid in it`).toContain('process.pid');
      }
    }
  });
});

describe('the store is no more readable than the files it replaced', () => {
  // `node:sqlite` takes no mode and follows the umask; the store holds paths and redacted quotes.
  const mode = (p: string): string => (statSync(p).mode & 0o777).toString(8);

  it('creates the database 0600', () => {
    const dir = scratch();
    openStore(dir).close();
    expect(mode(join(dir, 'store.db'))).toBe('600');
  });

  it('tightens a store that was created world-readable', () => {
    // Repair path for a store created before the fix.
    const dir = scratch();
    openStore(dir).close();
    chmodSync(join(dir, 'store.db'), 0o644);
    openStore(dir).close();
    expect(mode(join(dir, 'store.db'))).toBe('600');
  });

  it('gets 0600 on the WAL and SHM too, which hold uncommitted rows', () => {
    // The fix depends on SQLite matching companion files to the main file's mode.
    const dir = scratch();
    const db = openStore(dir);
    db.exec('BEGIN IMMEDIATE');
    putOccurrences(db, [occ()]);
    for (const f of ['store.db-wal', 'store.db-shm']) {
      expect(mode(join(dir, f)), `${f} is readable by other users`).toBe('600');
    }
    db.exec('ROLLBACK');
    db.close();
  });

  it('opens even when the mode cannot be set', () => {
    // Principle Zero outranks a tightened mode.
    const dir = scratch();
    openStore(dir).close();
    chmodSync(join(dir, 'store.db'), 0o400);
    expect(() => openStore(dir).close()).not.toThrow();
  });
});

describe('a session row keeps the time the work happened', () => {
  // The row outlives the transcript, so after the harness TTL it is the only record of when.
  const span = (db: Db, id: string) =>
    db.prepare('SELECT first_ts, last_ts FROM session WHERE id = ?').get(id) as {
      first_ts: string | null;
      last_ts: string | null;
    };
  const row = { id: 's1', project: 'p', sizeBytes: 10, packetTokens: 100 };

  it('stores the span, and a later parse of a live session moves its end', () => {
    const db = openStore(scratch());
    putSessionCost(db, [{ ...row, firstTs: '2026-10-20T17:57:00.000Z', lastTs: '2026-10-20T18:00:00.000Z' }]);
    putSessionCost(db, [{ ...row, firstTs: '2026-10-20T17:57:00.000Z', lastTs: '2026-10-24T19:01:00.000Z' }]);
    expect(span(db, 's1')).toEqual({
      first_ts: '2026-10-20T17:57:00.000Z',
      last_ts: '2026-10-24T19:01:00.000Z',
    });
    db.close();
  });

  it('leaves the span NULL when no event carried a time', () => {
    const db = openStore(scratch());
    putSessionCost(db, [row]);
    expect(span(db, 's1')).toEqual({ first_ts: null, last_ts: null });
    db.close();
  });
});
