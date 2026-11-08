/** Did a fix land and did its dimension recur: sightings from a transcript, then counts per project. */

import { describe, expect, it } from 'vitest';
import { fixStates, ruleHash, sightingsIn, type OutcomeSession } from '../src/outcome.ts';
import type { ApplyPlan } from '../src/fix.ts';
import type { Event } from '../src/types.ts';

const RULE = '- Do only what was asked.';
const plan: ApplyPlan = { fixId: 'a1b2c3', dimension: 'overreach', target: 'project-instructions', text: RULE };
const ev = (seq: number, o: Partial<Event> = {}): Event =>
  ({ sessionId: 's', harness: 'claude-code', uuid: `u${seq}`, parentUuid: null, seq, isSidechain: false, turnType: 'user_prompt', ts: `2026-10-2${seq}T00:00:00.000Z`, ...o }) as Event;

describe('sightings in one session', () => {
  it('dates a fix by the prompt carrying its marker, and a rule by the instructions that loaded it', () => {
    const s = sightingsIn('s', 'p', [ev(1), ev(2, { fixApplied: ['a1b2c3'] })], [{ fromSeq: 1, text: `# Rules\n${RULE}\n- other` }], [RULE, '- never seen']);
    expect(s.applied).toEqual([{ key: 'a1b2c3', project: 'p', sessionId: 's', at: '2026-10-22T00:00:00.000Z' }]);
    expect(s.loaded).toEqual([{ key: ruleHash(RULE), project: 'p', sessionId: 's', at: '2026-10-21T00:00:00.000Z' }]);
  });

  it('dates a load before the first reply as the session start, and a later one (a compaction) when it happened', () => {
    const events = [ev(1), ev(2), ev(3, { turnType: 'assistant_msg' }), ev(4)];
    const at = (fromSeq: number) => sightingsIn('s', 'p', events, [{ fromSeq, text: RULE }], [RULE]).loaded[0]?.at;
    expect(at(2)).toBe('2026-10-21T00:00:00.000Z');
    expect(at(4)).toBe('2026-10-24T00:00:00.000Z');
  });
});

const session = (id: string, day: number, times: number, o: Partial<OutcomeSession> = {}): OutcomeSession =>
  ({ id, project: 'p', at: `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`, judged: true, found: times > 0 ? { overreach: { times, turn: 7 } } : {}, ...o });

describe('one fix in one project', () => {
  const applied = [{ key: 'a1b2c3', project: 'p', sessionId: 'apply', at: '2026-10-10T12:00:00.000Z' }];
  const sessions = [
    session('b1', 1, 2), session('b2', 5, 1), session('b3', 8, 0),
    session('apply', 10, 1),
    session('a1', 12, 0), session('a2', 14, 1), session('a3', 15, 0),
    session('elsewhere', 13, 5, { project: 'q' }),
    session('unjudged', 13, 0, { judged: false }),
  ];

  it('is waiting until its marker is seen', () => {
    expect(fixStates([plan], [], [], sessions, 'p', () => true)).toEqual([plan]);
  });

  const loadedAt = [{ key: ruleHash(RULE), project: 'p', sessionId: 'a1', at: '2026-10-11T00:00:00.000Z' }];

  it('counts before and since in this project only, leaving out the session that applied it', () => {
    const [f] = fixStates([plan], applied, loadedAt, sessions, 'p', () => true);
    expect(f?.before).toEqual({ times: 3, sessions: 3 });
    expect(f?.since).toEqual({ times: 1, sessions: 3 });
    expect(f?.cameBack).toEqual({ sessionId: 'a2', turn: 7 });
  });

  it('leaves out a session the rule first loaded into mid-way, as it does the applying one', () => {
    const mid = session('mid', 11, 4);
    const loadedMidway = [{ key: ruleHash(RULE), project: 'p', sessionId: 'mid', at: '2026-10-11T06:00:00.000Z' }];
    const [f] = fixStates([plan], applied, loadedMidway, [...sessions, mid], 'p', () => true);
    expect(f?.before).toEqual({ times: 3, sessions: 3 });
    expect(f?.since).toEqual({ times: 1, sessions: 3 });
    const atStart = [{ key: ruleHash(RULE), project: 'p', sessionId: 'mid', at: '2026-10-11T00:00:00.000Z' }];
    expect(fixStates([plan], applied, atStart, [...sessions, mid], 'p', () => true)[0]?.since, 'loaded at its start: counted').toEqual({ times: 5, sessions: 4 });
  });

  it('counts every analysed session for a rule dimension, judged ones only for a model dimension', () => {
    expect(fixStates([plan], applied, loadedAt, sessions, 'p', () => false)[0]?.since?.sessions).toBe(4);
  });

  it('is in effect only once its rule is seen loaded after it was applied', () => {
    const before = [{ key: ruleHash(RULE), project: 'p', sessionId: 'b1', at: '2026-10-01T00:00:00.000Z' }];
    const after = [{ key: ruleHash(RULE), project: 'p', sessionId: 'a1', at: '2026-10-12T00:00:00.000Z' }];
    const declined = fixStates([plan], applied, before, sessions, 'p', () => true)[0]
    expect(declined?.inEffect).toBe(false);
    // Never loaded: the request may have been declined, so nothing is counted against it.
    expect(declined?.since).toBeUndefined();
    expect(fixStates([plan], applied, after, sessions, 'p', () => true)[0]?.inEffect).toBe(true);
  });

  it('is not applied in a project where its marker was never seen', () => {
    expect(fixStates([plan], applied, [], sessions, 'q', () => true)[0]?.applied).toBeUndefined();
  });

  it('counts a keyed fix by its own constraint, not every finding in its dimension', () => {
    const push: ApplyPlan = { fixId: 'f00d00', dimension: 'overreach', target: 'project-permissions', text: 'git push', key: 'action:git push' };
    const marked = [{ key: 'f00d00', project: 'p', sessionId: 'apply', at: '2026-10-10T12:00:00.000Z' }];
    const keyed = sessions.map((x) => (x.id === 'b1' ? { ...x, keys: { 'action:git push': { times: 1, turn: 3 } } } : x));
    const [f] = fixStates([push], marked, [], keyed, 'p', () => true);
    expect(f?.counts).toBe('same-fix');
    expect(f?.before).toEqual({ times: 1, sessions: 3 });
    expect(f?.since).toEqual({ times: 0, sessions: 3 });
    expect(f?.cameBack).toBeUndefined();
  });

  it('counts a quote-keyed fix by its dimension, and says so', () => {
    const words: ApplyPlan = { ...plan, key: 'quote:abc' };
    expect(fixStates([words], applied, loadedAt, sessions, 'p', () => true)[0]).toMatchObject({ counts: 'same-kind', since: { times: 1, sessions: 3 } });
  });
});

describe('the store keeps the earliest sighting per project', () => {
  it('lets an earlier sighting replace a later one, never the reverse', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { openStore, putFixApplied, readFixApplied } = await import('../src/store.ts');
    const db = openStore(mkdtempSync(join(tmpdir(), 'as-fix-')));
    putFixApplied(db, [{ key: 'a1b2c3', project: 'p', sessionId: 'late', at: '2026-10-20T00:00:00.000Z' }]);
    putFixApplied(db, [{ key: 'a1b2c3', project: 'p', sessionId: 'early', at: '2026-10-10T00:00:00.000Z' }]);
    putFixApplied(db, [{ key: 'a1b2c3', project: 'p', sessionId: 'later', at: '2026-10-25T00:00:00.000Z' }]);
    putFixApplied(db, [{ key: 'a1b2c3', project: 'q', sessionId: 'other', at: '2026-10-25T00:00:00.000Z' }]);
    expect(readFixApplied(db).map((r) => [r.project, r.sessionId]).sort()).toEqual([['p', 'early'], ['q', 'other']]);
    db.close();
  });
});

describe('who wrote a quote', () => {
  it('is the developer only when one of their prompts holds it', async () => {
    const { quoteAuthor } = await import('../src/gather.ts');
    const events = [
      { turnType: 'user_prompt', isSidechain: false, textSummary: 'Alright lets continue with the fix task' },
      { turnType: 'assistant_msg', isSidechain: false, textSummary: 'No response requested.' },
    ] as never;
    expect(quoteAuthor(events, 'No response requested.')).toBe('agent');
    expect(quoteAuthor(events, 'continue with the fix task')).toBe('developer');
    expect(quoteAuthor(events, 'something nobody wrote here')).toBeUndefined();
    const long = [ev(1, { textSummary: 'A long prompt, cut short …' })];
    expect(quoteAuthor(long, 'the part past the cut'), 'past the summary cap').toBeUndefined();
    expect(quoteAuthor(long, 'the part past the cut', new Map([[1, 'A long prompt, cut short and the part past the cut.']]))).toBe('developer');
  });
});

describe('the sessions the pane counts outcomes over', () => {
  it('counts a finding with its own fix under that fix key, and one without only under its dimension', async () => {
    const { outcomeSessions } = await import('../src/cmd/report.ts');
    const judged = (id: string, turn: number) => ({ id, at: '2026-10-20T00:00:00.000Z', dimension: 'constraint_violation', turns: [turn], why: '' });
    const list = [{ sessionId: 's1', findings: [], judged: [judged('pushed', 4), judged('other', 9)] }] as never;
    const [s] = outcomeSessions(list, new Map([['pushed', 'action:git push']]), new Map([['s1', { project: 'p', firstTs: '2026-10-20T00:00:00.000Z' }]]), { s1: 1 });
    expect(s?.found).toEqual({ constraint_violation: { times: 2, turn: 4 } });
    expect(s?.keys).toEqual({ 'action:git push': { times: 1, turn: 4 } });
    expect(s).toMatchObject({ project: 'p', judged: true });
  });
});
