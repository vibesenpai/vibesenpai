/**
 * `src/judge-store.ts` — the state that decides whether money gets spent.
 */

import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BYTES_PER_TURN, DEFAULT_SETTINGS, dueForJudging, emptyState, findingsFor,
  readJudgeState, recordPass, recordSpend, writeSettings,
} from '../src/judge-store.ts';

const archive = (): string => mkdtempSync(join(tmpdir(), 'as-judge-'));

describe('settings live alone, and that is the point', () => {
  it('is ON, because the trigger moved rather than the consent', () => {
    expect(DEFAULT_SETTINGS.enabled).toBe(true);
    expect(readJudgeState(archive()).settings.enabled).toBe(true);
  });

  it('round-trips', () => {
    const dir = archive();
    expect(writeSettings(dir, { ...DEFAULT_SETTINGS, enabled: false, model: 'sonnet' })).toBe(true);
    const back = readJudgeState(dir).settings;
    expect(back.enabled).toBe(false);
    expect(back.model).toBe('sonnet');
  });

  it('falls back to defaults rather than throwing on a bad file', () => {
    // Principle Zero: a corrupt file must not stop a session starting.
    const dir = archive();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'judge-settings.json'), '{ this is not json');
    expect(readJudgeState(dir).settings).toEqual(DEFAULT_SETTINGS);
  });

  // ── The consent race, which used to be real ──────────────────────────────
  //
  // Settings shared `judge.json` with the ledger, the findings and the usage
  // counters. A pass holds whole state in memory for up to six minutes and
  // rewrote all of it on the way out — so a user who ran `judge --disable
  // --apply` mid-pass had it silently set back to `true`. The user turns the
  // model off and the tool turns it on.
  //
  // The fix is structural rather than a lock: **no producer opens the settings
  // file**, so a pass cannot undo a decision it never reads.
  it('survives a pass that started before the user disabled it', () => {
    const dir = archive();
    writeSettings(dir, { ...DEFAULT_SETTINGS, enabled: true });

    // A pass reads state, including `enabled: true`.
    const passCopy = readJudgeState(dir);
    expect(passCopy.settings.enabled).toBe(true);

    // The user disables it while that pass is still running.
    writeSettings(dir, { ...passCopy.settings, enabled: false });

    // The pass finishes and records everything it produced.
    recordPass(dir, [], new Map([['some-session', 50_000]]));

    expect(readJudgeState(dir).settings.enabled, 'the user decided; the pass does not get a vote').toBe(false);
  });

  it('records what a call cost even when the work after it fails', () => {
    // Spend is not conditional on success: the money left the account when the
    // call returned. The watermark is conditional, because it means "we have
    // results", and advancing it first is how this project lost paid-for
    // episodes whenever stage B threw.
    const dir = archive();
    recordSpend(dir, { calls: 1, tokensIn: 58_161, tokensOut: 3_962 });

    const back = readJudgeState(dir);
    expect(back.usage.calls).toBe(1);
    expect(back.usage.inputTokens).toBe(58_161);
    expect(back.ledger, 'no results, so no progress').toEqual({});
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

describe('an unreadable store is not an empty one', () => {
  // `readProgress` catches — it must, Principle Zero outranks a correct count
  // — but it returned a value **identical to an empty store**. So
  // `judge --status` printed `judged 0 session(s) · 0 finding(s)` over a
  // database it had failed to open, which is this project's own
  // `inaccurate_self_report` dimension appearing in its own status output.
  const scratch = (): string => mkdtempSync(join(tmpdir(), 'as-unreadable-'));

  it('flags a store that is not a database', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'store.db'), randomBytes(4096));
    const state = readJudgeState(dir);
    expect(state.storeUnreadable, 'a failed read must be distinguishable').toBe(true);
  });

  it('does not flag a healthy store, however empty', () => {
    // The flag means "could not read", never "found nothing" — otherwise the
    // honest case starts reporting unknown and the warning becomes noise.
    const dir = scratch();
    const state = readJudgeState(dir);
    expect(state.storeUnreadable).toBeUndefined();
    expect(state.findings).toEqual([]);
  });

  it('still returns usable settings, so a session can start', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'store.db'), randomBytes(4096));
    expect(readJudgeState(dir).settings.model).toBe(DEFAULT_SETTINGS.model);
  });

  it('says unknown rather than a number', () => {
    const src = readFileSync('src/cli.ts', 'utf8');
    expect(src).toMatch(/storeUnreadable === true/);
    expect(src).toMatch(/the store could not be read/);
  });
});
