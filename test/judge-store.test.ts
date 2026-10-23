/**
 * `src/judge-store.ts` — the state that decides whether money gets spent.
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BYTES_PER_TURN, DEFAULT_SETTINGS, dueForJudging, emptyState, findingsFor,
  readJudgeState, writeJudgeState,
} from '../src/judge-store.ts';

const archive = (): string => mkdtempSync(join(tmpdir(), 'as-judge-'));

describe('settings', () => {
  it('is ON, because the trigger moved rather than the consent', () => {
    // This asserted `false`, and the reasoning held for a CLI installed from
    // npm: a detached process spending money while the user is absent is the
    // Self-Initiated Overreach this tool exists to detect.
    //
    // The entry point is now `/plugin install`, and the structural tier alone
    // is one detector — 4 occurrences across 18 real sessions where the judge
    // found 19. What keeps the principle intact is that **the `Stop` hook no
    // longer spawns a pass**: nothing is judged until the user runs a command.
    // That boundary is asserted in `test/spend-boundary.test.ts`, and it is the
    // one that matters.
    expect(DEFAULT_SETTINGS.enabled).toBe(true);
    expect(readJudgeState(archive()).settings.enabled).toBe(true);
  });

  it('reads back what was written', () => {
    const dir = archive();
    const s = emptyState();
    s.settings.enabled = true;
    s.usage = { calls: 2, inputTokens: 80_000, outputTokens: 12_000 };
    expect(writeJudgeState(dir, s)).toBe(true);
    const back = readJudgeState(dir);
    expect(back.settings.enabled).toBe(true);
    expect(back.usage.inputTokens).toBe(80_000);
  });

  it('falls back to a fresh state rather than throwing on a bad file', () => {
    // A corrupt store must not stop a session starting — Principle Zero.
    const dir = archive();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'judge.json'), '{ this is not json');
    const back = readJudgeState(dir);
    expect(back.settings).toEqual(DEFAULT_SETTINGS);
    expect(back.findings).toEqual([]);
  });

  // ── A version bump must not cost the user anything ─────────────────────
  //
  // The previous code returned `emptyState()` on any version mismatch, which
  // would have turned the judge OFF for a user who had explicitly enabled it,
  // and wiped the ledger so every session was re-judged and re-billed from
  // byte 0. Both are things this project would refuse to do on purpose, so it
  // must not do them by accident either.

  it('keeps consent and the ledger across a version bump', () => {
    const dir = archive();
    const old = {
      v: 1,
      settings: { enabled: true, model: 'haiku', cadence: 50, maxBatchTokens: 60_000 },
      ledger: { 'session-a': 412_000, 'session-b': 9_100 },
      findings: [],
      usage: { calls: 7, inputTokens: 900_000, outputTokens: 40_000 },
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'judge.json'), JSON.stringify(old));

    const back = readJudgeState(dir);
    expect(back.settings.enabled).toBe(true);
    expect(back.ledger).toEqual({ 'session-a': 412_000, 'session-b': 9_100 });
    expect(back.usage.inputTokens).toBe(900_000);
    expect(back.v).toBe(2);
  });

  it('keeps a v1 finding that is still anchorable, and drops one that is not', () => {
    const dir = archive();
    const old = {
      v: 1,
      settings: { enabled: true },
      ledger: {},
      // The first has no `name`/`description` — v1 never had them — but it can
      // still be rendered and pointed at, so discarding it would be a loss for
      // a cosmetic reason.
      findings: [
        { sessionId: 's1', dimension: 'constraint_violation', turns: [42], quote: 'no new deps', why: 'added one', at: 'x' },
        { sessionId: 's2', dimension: 'misread_intent', why: 'no anchor at all' },
      ],
      usage: { calls: 1, inputTokens: 10, outputTokens: 2 },
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'judge.json'), JSON.stringify(old));

    const back = readJudgeState(dir);
    expect(back.findings).toHaveLength(1);
    expect(back.findings[0]?.sessionId).toBe('s1');
    expect(back.settings.enabled).toBe(true);
  });

  it('does not overwrite the state of a NEWER version of the tool', () => {
    const dir = archive();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'judge.json'), JSON.stringify({
      v: 99, settings: { enabled: true }, ledger: { s: 5 }, findings: [],
      usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
    }));
    const back = readJudgeState(dir);
    expect(back.settings.enabled).toBe(true);
    expect(back.ledger).toEqual({ s: 5 });
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
