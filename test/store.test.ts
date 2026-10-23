/**
 * The store exists because of three measured failures, and this file is them.
 *
 * Every test here fails against the flat-file store it replaces. They are
 * written as the behaviour we need rather than as a description of SQLite,
 * so they stay meaningful if the storage engine is ever swapped again —
 * `PLAN.md` names `better-sqlite3` as the fallback if the RC API bites.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addSpend,
  advanceLedger,
  groupedFindings,
  judgedBytes,
  occurrencesFor,
  openStore,
  putOccurrences,
  readSpend,
  transact,
  type Db,
  type OccurrenceRow,
} from '../src/store.ts';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'as-store-'));
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
  // The measurement that started this, run against the flat store:
  //
  //   two writers, each adding one ledger entry
  //   before: 12     after: 13     expected: 14
  //
  // Both writers read whole state, mutated their own copy, and wrote it back.
  // The second rename won. Nothing reported it.
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
    // Same shape, and the one that costs real money: a pass appends findings
    // it has already paid a model for, and another pass overwrites them.
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
    // A pass resuming from an older offset must not drag the watermark down,
    // because the bytes between have been paid for and reported already.
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
    // Idempotency comes free: the id is already a hash of dimension, session
    // and subject, so a re-run produces identical ids. This is the standard
    // incremental-pipeline answer — at-least-once delivery plus an idempotent
    // destination — and the key for it already existed.
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
    // What the flat store could not do. On the real machine:
    //
    //   edit_retry: 4 occurrences across 2 sessions, 3 files
    //     but only ONE subject is kept
    //
    // Two of three files were unrecoverable, because the aggregation had been
    // frozen into storage. Here the aggregation is a query, so every question
    // stays answerable.
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

    const grouped = groupedFindings(db);
    expect(grouped.map((g) => g.subject).sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(grouped.find((g) => g.subject === 'a.ts')).toMatchObject({
      occurrences: 2,
      sessions: 2,
    });
    db.close();
  });

  it('never collapses the two tiers', () => {
    // `certain` means the harness refused the call and said why. A judge
    // finding is a model's reading. Every surface keeps them apart, and so
    // does the store.
    const dir = scratch();
    const db = openStore(dir);
    transact(db, () =>
      putOccurrences(db, [
        occ({ id: 'r', tier: 'rule' }),
        occ({ id: 'j', tier: 'judge', dimension: 'misread_intent', confidence: 'likely' }),
      ]),
    );
    expect(groupedFindings(db, { tier: 'rule' })).toHaveLength(1);
    expect(groupedFindings(db, { tier: 'judge' })).toHaveLength(1);
    db.close();
  });
});

describe('spend and progress are separate facts', () => {
  it('records what was paid even when the work that followed failed', () => {
    // The documented pitfall is moving the watermark before the load. This
    // project does exactly that — `scripts/judge.ts` advances the ledger after
    // stage A, and its own comment accepts that a stage-B failure loses those
    // episodes permanently.
    //
    // Separated, the honest thing happens: the spend is recorded because the
    // call returned, and the watermark does not move because there are no
    // results. The bytes get re-billed on the next pass rather than the
    // findings being silently discarded — for an evidence tool, the right way
    // round.
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
    // The capability the whole pipeline rests on: a detached producer writes
    // for up to a minute while `:session` must answer instantly. Without WAL
    // the reader waits for the slowest thing in the system.
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
