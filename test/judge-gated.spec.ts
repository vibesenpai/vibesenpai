/** What the lookback gate drops is stored, redacted, so a missed failure can be read rather than inferred. */

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatedRows, recordPass } from '../src/judge/state.ts';
import { openStore, readGated } from '../src/store.ts';
import type { LabelResult } from '../src/judge/prompt.ts';

const archive = (): string => mkdtempSync(join(tmpdir(), 'as-gated-'));
const TOKEN = 'ghp_AbCdEf1234567890AbCdEf1234567890';

const drop = (quote: string, claimed?: string): LabelResult['gated'][number] => ({
  episode: {
    sessionId: 's1',
    name: 'Pushed Without Asking',
    description: 'd',
    alignmentGoal: 'instruction',
    confidence: 'high',
    evidence: [{ quote, context: 'c', turns: [7, 9] }],
  },
  dimension: 'constraint_violation',
  reason: 'developer reference is not something the developer said',
  ...(claimed === undefined ? {} : { established: { source: 'developer-reference' as const, quote: claimed } }),
});

describe('gated records', () => {
  it('are stored with the findings and read back newest first', () => {
    const dir = archive();
    recordPass(dir, [], new Map([['s1', 100]]), new Map(), gatedRows([drop('you forgot your constraint again')], '2026-11-14T10:00:00.000Z'));
    recordPass(dir, [], new Map([['s1', 200]]), new Map(), gatedRows([drop('should I push?', 'no pushes')], '2026-11-15T10:00:00.000Z'));
    const db = openStore(dir);
    const rows = readGated(db);
    db.close();
    expect(rows.map((r) => r.quote)).toEqual(['should I push?', 'you forgot your constraint again']);
    expect(rows[0]).toMatchObject({ sessionId: 's1', dimension: 'constraint_violation', turns: [7, 9], name: 'Pushed Without Asking' });
    expect(JSON.parse(rows[0]?.claimed ?? '{}')).toEqual({ source: 'developer-reference', quote: 'no pushes' });
    expect(rows[1]?.claimed).toBeUndefined();
  });

  it('are redacted when built, never stored raw', () => {
    const rows = gatedRows([drop(`token ${TOKEN} pasted`, `use ${TOKEN}`)], '2026-11-15T10:00:00.000Z');
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });

  it('are idempotent when a pass is retried', () => {
    const dir = archive();
    const rows = gatedRows([drop('same quote')], '2026-11-15T10:00:00.000Z');
    recordPass(dir, [], new Map([['s1', 100]]), new Map(), rows);
    recordPass(dir, [], new Map([['s1', 100]]), new Map(), rows);
    const db = openStore(dir);
    expect(readGated(db)).toHaveLength(1);
    db.close();
  });
});
