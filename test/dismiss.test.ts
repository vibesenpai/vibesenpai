// `src/dismiss.ts`: setting findings aside without deleting them.

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  candidates,
  dismissalsFor,
  dismissedFrom,
  emptyDismissed,
  readDismissed,
  renderCandidates,
  resolve,
  shortIds,
  withoutDismissed,
} from '../src/dismiss.ts';
import { findingId, subjectIdOf } from '../src/finding.ts';
import { readJudgeState, recordPass } from '../src/judge/state.ts';
import {
  openStore,
  putDismissals,
  putOccurrences,
  putSessionCost,
  readDismissals,
  removeDismissals,
  transact,
  type Db,
} from '../src/store.ts';
import type { Finding } from '../src/types.ts';

const archive = (): string => mkdtempSync(join(tmpdir(), 'as-dismiss-'));

/** Two sessions in one project, a rule subject in both, and one judge finding. */
function seed(dir: string): Db {
  const db = openStore(dir);
  transact(db, () => {
    putSessionCost(db, [
      { id: 's1', project: 'proj', sizeBytes: 10, packetTokens: 1, lastTs: '2026-10-20T10:00:00Z' },
      { id: 's2', project: 'proj', sizeBytes: 10, packetTokens: 1, lastTs: '2026-10-24T10:00:00Z' },
    ]);
    putOccurrences(db, [
      { id: 'r1', sessionId: 's1', dimension: 'edit_retry', tier: 'rule', subject: '/x/a.ts', confidence: 'certain', at: 'now' },
      { id: 'r2', sessionId: 's2', dimension: 'edit_retry', tier: 'rule', subject: '/x/a.ts', confidence: 'certain', at: 'now' },
      { id: 'r3', sessionId: 's2', dimension: 'edit_retry', tier: 'rule', subject: '/x/a.ts', confidence: 'certain', at: 'now' },
    ]);
  });
  db.close();
  recordPass(
    dir,
    [{ sessionId: 's2', dimension: 'misread_intent', turns: [4, 7], why: 'asked a question', at: 'now', quote: 'are we planning trends?' }],
    new Map([['s2', 10]]),
  );
  return openStore(dir);
}

describe('what can be dismissed', () => {
  it('groups a rule subject across sessions and keeps judge findings one each', () => {
    const db = seed(archive());
    const cs = candidates(db, emptyDismissed());
    const rule = cs.find((c) => c.tier === 'rule');
    expect(rule?.key).toBe(subjectIdOf('edit_retry', 'proj', '/x/a.ts'));
    expect(rule?.occurrences).toBe(3);
    expect(rule?.sessions.sort()).toEqual(['s1', 's2']);
    expect(rule?.findingIds.sort()).toEqual(
      [findingId('edit_retry', 's1', '/x/a.ts'), findingId('edit_retry', 's2', '/x/a.ts')].sort(),
    );
    const judge = cs.find((c) => c.tier === 'judge');
    expect(judge?.turns).toEqual([4, 7]);
    expect(judge?.quote).toBe('are we planning trends?');
    db.close();
  });

  it('marks every judge line as flagged by a model', () => {
    const db = seed(archive());
    const out = renderCandidates(candidates(db, emptyDismissed()));
    const judgeLine = out.split('\n').find((l) => l.includes('misread intent'));
    expect(judgeLine).toContain('flagged by a model');
    expect(out.split('\n').find((l) => l.includes('edit retry'))).not.toContain('model');
    db.close();
  });
});

describe('dismissing', () => {
  it('a rule subject stays dismissed in sessions not yet written', () => {
    const db = seed(archive());
    const rule = candidates(db, emptyDismissed()).find((c) => c.tier === 'rule');
    if (rule === undefined) throw new Error('no rule candidate');
    putDismissals(db, dismissalsFor(rule, 'noise', 'now'));
    const d = dismissedFrom(readDismissals(db));
    // A later session's finding on the same subject is still hidden.
    const later = { id: findingId('edit_retry', 's9', '/x/a.ts'), subjectId: rule.key } as Finding;
    expect(withoutDismissed([later], d).findings).toEqual([]);
    db.close();
  });

  it('clearing a rule subject lets it come back in a new session', () => {
    const db = seed(archive());
    const rule = candidates(db, emptyDismissed()).find((c) => c.tier === 'rule');
    if (rule === undefined) throw new Error('no rule candidate');
    putDismissals(db, dismissalsFor(rule, 'cleared', 'now'));
    const d = dismissedFrom(readDismissals(db));
    const seen = { id: findingId('edit_retry', 's2', '/x/a.ts'), subjectId: rule.key } as Finding;
    const recurred = { id: findingId('edit_retry', 's9', '/x/a.ts'), subjectId: rule.key } as Finding;
    const out = withoutDismissed([seen, recurred], d);
    expect(out.findings).toEqual([recurred]);
    expect(out.dismissed).toBe(1);
    db.close();
  });

  it('a judge finding is dismissed alone, never its whole dimension', () => {
    const db = seed(archive());
    const judge = candidates(db, emptyDismissed()).find((c) => c.tier === 'judge');
    if (judge === undefined) throw new Error('no judge candidate');
    const rows = dismissalsFor(judge, 'wrong', 'now');
    expect(rows).toEqual([{ key: judge.key, scope: 'judged', dimension: 'misread_intent', reason: 'wrong', at: 'now' }]);
    db.close();
  });

  it('hides a dismissed judge finding from every surface, and not from the judge', () => {
    const dir = archive();
    const db = seed(dir);
    const judge = candidates(db, emptyDismissed()).find((c) => c.tier === 'judge');
    if (judge === undefined) throw new Error('no judge candidate');
    putDismissals(db, dismissalsFor(judge, 'wrong', 'now'));
    db.close();
    const shown = readJudgeState(dir);
    expect(shown.findings).toEqual([]);
    expect(shown.dismissed).toBe(1);
    // The judge is told what it already reported, so it does not report it again.
    expect(readJudgeState(dir, { dismissed: 'include' }).findings).toHaveLength(1);
  });

  it('leaves the listing once dismissed, and comes back on undo', () => {
    const dir = archive();
    const db = seed(dir);
    const all = candidates(db, emptyDismissed());
    putDismissals(db, all.flatMap((c) => dismissalsFor(c, 'cleared', 'now')));
    expect(candidates(db, dismissedFrom(readDismissals(db)))).toEqual([]);
    const n = removeDismissals(db, readDismissals(db).map((r) => r.key));
    expect(n).toBeGreaterThan(0);
    expect(candidates(db, dismissedFrom(readDismissals(db)))).toHaveLength(all.length);
    db.close();
  });

  it('stores ids and enums, never what the finding said', () => {
    const db = seed(archive());
    const all = candidates(db, emptyDismissed());
    putDismissals(db, all.flatMap((c) => dismissalsFor(c, 'wrong', 'now')));
    const text = JSON.stringify(readDismissals(db));
    expect(text).not.toContain('planning trends');
    expect(text).not.toContain('a.ts');
    db.close();
  });

  it('reads as nothing dismissed when there is no store', () => {
    const d = readDismissed(join(archive(), 'missing', 'deeper'));
    expect(d.subjects.size + d.findings.size + d.judged.size).toBe(0);
  });
});

describe('short ids', () => {
  it('are at least six characters and unique among what is listed', () => {
    const ids = shortIds(['abcdef0123', 'abcdef9999', '1234567890']);
    expect(ids.get('1234567890')).toBe('123456');
    expect(ids.get('abcdef0123')).toBe('abcdef0');
    expect(ids.get('abcdef9999')).toBe('abcdef9');
  });

  it('refuse a prefix that is too short or ambiguous rather than guess', () => {
    const items = ['abcdef0123', 'abcdef9999'];
    const r = resolve(items, (x) => x, ['abc', 'abcdef', 'abcdef0', 'ffff']);
    expect(r.found).toEqual(['abcdef0123']);
    expect(r.ambiguous).toEqual(['abcdef']);
    expect(r.unknown).toEqual(['abc', 'ffff']);
  });
});
