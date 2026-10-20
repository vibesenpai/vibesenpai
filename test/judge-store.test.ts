/**
 * `src/judge-store.ts` — the state that decides whether money gets spent.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BYTES_PER_TURN, DEFAULT_SETTINGS, dueForJudging, emptyState, findingsFor,
  readJudgeState, writeJudgeState,
} from '../src/judge-store.ts';

const archive = (): string => mkdtempSync(join(tmpdir(), 'as-judge-'));

describe('settings', () => {
  it('is OFF until somebody says otherwise', () => {
    // The one part of the tool that spends money in a detached process while
    // the user is not present. Consent is an explicit act.
    expect(DEFAULT_SETTINGS.enabled).toBe(false);
    expect(readJudgeState(archive()).settings.enabled).toBe(false);
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
    writeJudgeState(dir, { ...emptyState(), v: 99 } as never);
    expect(readJudgeState(dir).settings.enabled).toBe(false);
  });
});

describe('dueForJudging', () => {
  it('waits for a cadence worth of new bytes', () => {
    // Stop fires at every response boundary — ~788 times in one real session —
    // and an invocation costs ~27,000 tokens of overhead before our packet.
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
