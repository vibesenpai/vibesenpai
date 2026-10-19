/**
 * The ambient layer: Principle Zero and Principle One, as tests.
 *
 * These are not formatting tests. Every assertion here corresponds to a
 * guarantee that was *claimed* and could be silently false — and one of them
 * already was: `enqueue` dropped `shownAt`, so the rate limit never engaged and
 * the nudge never decayed. Nothing threw, and the pipeline looked fine.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  advance, emptyQueue, enqueue, lineFor, markShown, pick, readQueue, writeQueue,
  DECAY_BOUNDARIES, MIN_BOUNDARIES_BETWEEN,
} from '../src/queue.ts';
import { closed, isTripped, readBreaker, recordFailure, recordSuccess, TRIP_AFTER } from '../src/breaker.ts';
import { addHook, addStatusLine, describeChange, planFor, remove, setStatusLine, type Settings } from '../src/install.ts';
import { materialise } from '../src/finding.ts';
import type { Finding } from '../src/types.ts';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'as-ambient-'));

const finding = (subject: string, occurrences = 2): Finding => ({
  ...materialise({
    candidate: {
      dimension: 'edit_retry',
      subject,
      evidence: Array.from({ length: occurrences }, (_, i) => ({ uuid: `u${i}`, sessionId: 's1', seq: i })),
      confidence: 'certain',
      method: 'RULE',
      polarity: 'lower-is-better',
      requiresOutcome: false,
    },
    sessionId: 's1',
    project: 'p',
    now: '2026-10-19T00:00:00.000Z',
  }),
});

describe('queue — Principle Zero: a broken store costs a nudge, never a session', () => {
  it('reads a missing file as an empty queue', () => {
    expect(readQueue(join(scratch(), 'nope'))).toEqual(emptyQueue());
  });

  it('reads garbage as an empty queue rather than throwing', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'queue.json'), 'not json at all{{{');
    expect(() => readQueue(dir)).not.toThrow();
    expect(readQueue(dir).entries).toEqual([]);
  });

  it('reads a truncated file as an empty queue', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'queue.json'), '{"v":1,"boundaries":3,"entries":[{"dimen');
    expect(readQueue(dir).entries).toEqual([]);
  });

  it('treats an unknown version as absent rather than guessing its shape', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'queue.json'), JSON.stringify({ v: 999, boundaries: 9, entries: [{ dimension: 'x' }] }));
    expect(readQueue(dir)).toEqual(emptyQueue());
  });

  it('reports a failed write instead of throwing', () => {
    const dir = scratch();
    chmodSync(dir, 0o500); // read-only
    expect(writeQueue(dir, emptyQueue())).toBe(false);
    chmodSync(dir, 0o700);
  });

  it('writes temp-then-rename, so a crash cannot leave a partial file', () => {
    const dir = scratch();
    expect(writeQueue(dir, advance(emptyQueue()))).toBe(true);
    // Parseable immediately: there is no window where the file is half-written.
    expect(readQueue(dir).boundaries).toBe(1);
    expect(() => readFileSync(join(dir, 'queue.json'), 'utf8')).not.toThrow();
  });
});

describe('queue — Principle One: the nudge paces itself and gives up', () => {
  it('says nothing on the first boundary of a session', () => {
    // A nudge before any work has happened reads as a verdict on work that has
    // not happened yet.
    const q = enqueue(emptyQueue(), 's1', [finding('/a.ts')]);
    expect(pick(q)).toBeUndefined();
  });

  it('holds the same line through the rate limit instead of flickering', () => {
    let q = advance(enqueue(emptyQueue(), 's1', [finding('/a.ts'), finding('/b.ts')]));
    const first = pick(q);
    expect(first).toBeDefined();
    q = markShown(q, first as never);

    for (let i = 1; i < MIN_BOUNDARIES_BETWEEN; i++) {
      q = advance(q);
      expect(pick(q)?.subject, `boundary +${i}`).toBe(first?.subject);
    }
    // Once the limit passes, it moves on to the one not yet shown.
    q = advance(q);
    expect(pick(q)?.subject).not.toBe(first?.subject);
  });

  it('drops an entry nobody acted on', () => {
    let q = enqueue(emptyQueue(), 's1', [finding('/a.ts')]);
    for (let i = 0; i < DECAY_BOUNDARIES; i++) q = advance(q);
    expect(q.entries).toEqual([]);
  });

  it('keeps shownAt and addedAt across a re-enqueue', () => {
    // The bug this file exists for. The detached analyser re-enqueues every
    // boundary; an enqueue that reset these made the rate limit and the decay
    // silently inert, and nothing threw.
    let q = advance(enqueue(emptyQueue(), 's1', [finding('/a.ts')]));
    q = markShown(q, pick(q) as never);
    const shownAt = q.entries[0]?.shownAt;
    expect(shownAt).toBeDefined();

    q = enqueue(q, 's1', [finding('/a.ts', 5)]); // same subject, grown
    expect(q.entries).toHaveLength(1);
    expect(q.entries[0]?.shownAt).toBe(shownAt);
    expect(q.entries[0]?.addedAt).toBe(0);
    expect(q.entries[0]?.occurrences).toBe(5); // but the count is current
  });

  it('replaces rather than appends, so one finding shows once', () => {
    let q = enqueue(emptyQueue(), 's1', [finding('/a.ts')]);
    q = enqueue(q, 's1', [finding('/a.ts')]);
    expect(q.entries).toHaveLength(1);
  });
});

describe('the line itself — a statement of fact', () => {
  it('uses no imperative verb, severity word or alarm', () => {
    const q = advance(enqueue(emptyQueue(), 's1', [finding('/a.ts', 3)]));
    const line = lineFor(pick(q), q.entries.length);
    expect(line).toContain('3 edits refused then retried');
    for (const nag of ['fix', 'should', 'must', 'warning', 'error', 'bad', '!']) {
      expect(line.toLowerCase(), `must not contain "${nag}"`).not.toContain(nag);
    }
  });

  it('is empty when there is nothing to say', () => {
    expect(lineFor(undefined)).toBe('');
  });

  it('counts the rest rather than listing them', () => {
    const q = advance(enqueue(emptyQueue(), 's1', [finding('/a.ts'), finding('/b.ts'), finding('/c.ts')]));
    expect(lineFor(pick(q), q.entries.length)).toContain('+2 more');
  });
});

describe('circuit breaker — degrade to silence, not to noise', () => {
  it('trips after repeated failures and records why', () => {
    const dir = scratch();
    for (let i = 0; i < TRIP_AFTER; i++) recordFailure(dir, 'parse exploded');
    const b = readBreaker(dir);
    expect(isTripped(b)).toBe(true);
    expect(b.reason).toBe('parse exploded');
    expect(b.trippedAt).toBeDefined();
  });

  it('closes completely on one success, so a transient failure does not linger', () => {
    const dir = scratch();
    recordFailure(dir, 'once');
    recordSuccess(dir);
    expect(readBreaker(dir)).toEqual(closed());
  });

  it('treats an unreadable breaker as closed, never as permanently disabled', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'breaker.json'), '}}}not json');
    expect(isTripped(readBreaker(dir))).toBe(false);
  });
});

describe('install — merge, never replace', () => {
  /**
   * The real shape measured on this machine: ten hook events, one hook each,
   * and **no `statusLine` key at all**.
   *
   * That last detail matters. An earlier fixture wrote `statusLine: null`,
   * matching a misread of `dict.get()` output, and the round-trip test passed
   * while the real uninstall added a key that had never existed. The fixture
   * now carries the shape the file actually has.
   */
  const realistic = (): Settings => ({
    theme: 'dark',
    model: 'opus',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'mem0-stop.sh' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'mem0-start.sh' }] }],
      PreToolUse: [{ hooks: [{ type: 'command', command: 'mem0-pre.sh' }] }],
    },
  });

  const plan = planFor('/repo/agentsensei', '/usr/bin/node');

  it("leaves somebody else's Stop hook completely alone", () => {
    const after = addHook(realistic(), plan);
    const commands = (after.hooks?.['Stop'] ?? []).flatMap((m) => m.hooks.map((h) => h.command));
    expect(commands).toContain('mem0-stop.sh');
    expect(commands.some((c) => c.includes('hook-stop.ts'))).toBe(true);
    expect(commands).toHaveLength(2);
  });

  it('never touches another hook event', () => {
    const before = realistic();
    const after = addHook(before, plan);
    expect(after.hooks?.['SessionStart']).toEqual(before.hooks?.['SessionStart']);
    expect(after.hooks?.['PreToolUse']).toEqual(before.hooks?.['PreToolUse']);
  });

  it('never touches unrelated top-level keys', () => {
    const after = addHook(realistic(), plan);
    expect(after.theme).toBe('dark');
    expect(after.model).toBe('opus');
  });

  it('is idempotent — installing twice adds one hook, not two', () => {
    const twice = addHook(addHook(realistic(), plan), plan);
    const ours = (twice.hooks?.['Stop'] ?? [])
      .flatMap((m) => m.hooks)
      .filter((h) => h.__agentsensei === true);
    expect(ours).toHaveLength(1);
  });

  it('gives the hook an explicit timeout, because a hung analyzer must be killed', () => {
    const ours = (addHook(realistic(), plan).hooks?.['Stop'] ?? [])
      .flatMap((m) => m.hooks)
      .find((h) => h.__agentsensei === true);
    expect(ours?.timeout).toBeGreaterThan(0);
    expect(ours?.timeout).toBeLessThanOrEqual(10);
  });

  it('makes the hook exit 0 whatever happens inside it', () => {
    expect(plan.hookCommand.endsWith('|| true')).toBe(true);
  });

  it("refuses to take over somebody else's statusline", () => {
    const occupied: Settings = { ...realistic(), statusLine: { type: 'command', command: 'my-own-prompt.sh' } };
    expect(addStatusLine(occupied)).toBe('occupied');
  });

  it('accepts a free statusline slot', () => {
    expect(addStatusLine(realistic())).not.toBe('occupied');
  });

  it('uninstalls to exactly the original settings', () => {
    // The property that makes installing safe to try: it is reversible.
    const before = realistic();
    const installed = setStatusLine(addHook(before, plan), plan);
    expect(remove(installed)).toEqual(before);
  });

  it('invents no statusLine key when there was none', () => {
    // Verified against the real file: the key is absent, not null. Setting null
    // on uninstall made the round-trip inexact, and the old fixture hid it.
    const before = realistic();
    expect('statusLine' in before).toBe(false);
    const round = remove(setStatusLine(addHook(before, plan), plan));
    expect('statusLine' in round).toBe(false);
  });

  it('also round-trips when the key was explicitly null', () => {
    // Absent and null mean the same thing to the harness, so deleting is exact
    // in effect for both — this pins that the other shape is handled too.
    const before: Settings = { ...realistic(), statusLine: null };
    const round = remove(setStatusLine(addHook(before, plan), plan));
    expect(round.statusLine ?? null).toBeNull();
  });

  it('uninstall removes nothing of anybody else’s, even from an empty group', () => {
    const before: Settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'theirs.sh' }] }] } };
    expect(remove(addHook(before, plan))).toEqual(before);
  });

  it('describes what it touches AND what it leaves alone', () => {
    const before = realistic();
    const lines = describeChange(before, setStatusLine(addHook(before, plan), plan)).join('\n');
    expect(lines).toContain('hooks.Stop');
    expect(lines).toContain('statusLine');
    expect(lines).toMatch(/untouched/);
    expect(lines).toContain('SessionStart'); // named as untouched
  });
});
