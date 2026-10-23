/**
 * The judge's own state: whether it may run, what it has judged, what it spent.
 *
 * A file of ours beside `standing.json` and `breaker.json`, rather than fields
 * in `Config`. `Config` is a layered resolution of *settings* with provenance —
 * flag beats env beats file beats default — and none of this is that. A ledger
 * of judged offsets has no meaningful "the environment said so", and threading
 * it through `pick()` would add a layer nobody could ever set.
 *
 * ── Off until somebody says otherwise ──────────────────────────────────────
 *
 * `enabled` defaults to false and only `judge --enable --apply` turns it on.
 * This is the one part of the tool that spends the user's money, in a detached
 * process, without them present — which is the Self-Initiated Overreach the
 * project exists to detect. Consent is an explicit act, the same way `install`
 * refuses to write anything without `--apply`.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JudgeDimension } from './judge.ts';

/**
 * v2 carries the extraction record — `quote`, `name`, `description`,
 * `alignmentGoal`, `confidence`, `context`, `otherDescriptor`.
 *
 * **A bump must never discard the file.** See `readJudgeState`.
 */
const VERSION = 2;

export type JudgeSettings = {
  enabled: boolean;
  /**
   * Default Haiku, on cost rather than quality.
   *
   * Measured: the same call costs ~1/38 the list price of the default model
   * for the same 26,384 tokens of overhead. Whether it is *good enough* is
   * the gold set's question, not this file's, and the answer is one value away.
   */
  model: string;
  /** Turns of new transcript before the live session is judged again. */
  cadence: number;
  /** A batch larger than this is split rather than sent. */
  maxBatchTokens: number;
};

export const DEFAULT_SETTINGS: JudgeSettings = {
  // ── On, because the entry point is the plugin ────────────────────────────
  //
  // This was `false`, and the reasoning was sound for the product we thought
  // we were building: a CLI someone installs from npm, where a detached
  // process spending their money unprompted is the Self-Initiated Overreach
  // this tool exists to detect.
  //
  // Two things changed. The entry point is `/plugin install`, which is itself
  // a deliberate act with a trust warning attached — and the structural tier
  // alone is **one detector**, which found 4 occurrences across 18 real
  // sessions where the judge found 19. Opt-in does not produce a cautious
  // product; it produces one nobody turns on.
  //
  // The principle survives intact because the trigger moved rather than the
  // consent: **nothing is judged until the user runs a command.** The `Stop`
  // hook no longer spawns a pass. See `cmdNow` in `cli.ts`, and `/insights`,
  // which spends a user's tokens on exactly these terms.
  enabled: true,
  model: 'haiku',
  // ~50 turns: a 788-turn session is judged a handful of times rather than
  // hundreds. Measured against the cost of an invocation (26,384 tokens of
  // overhead, and two-stage pays it twice), not against what feels responsive.
  cadence: 50,
  maxBatchTokens: 60_000,
};

export type JudgedFinding = {
  sessionId: string;
  dimension: JudgeDimension;
  turns: number[];
  why: string;
  /** When it was judged, so a stale finding can be told from a fresh one. */
  at: string;

  // ── v2: the extraction record ────────────────────────────────────────────
  //
  // The v2 bump was made for these and then they were never added, so the
  // comment above `VERSION` described a schema that did not exist. They are
  // here now. All optional, because a v1 finding on disk has none of them and
  // `isReadableFinding` deliberately does not require them — a finding is worth
  // keeping if it can be anchored, not if it is decorated.
  quote?: string;
  name?: string;
  description?: string;
  alignmentGoal?: 'instruction' | 'intention' | 'both';
  confidence?: 'high' | 'medium' | 'low';
  context?: string;
  /** Present only on `other`. The whole point of the escape hatch. */
  otherDescriptor?: string;
};

export type JudgeState = {
  v: number;
  settings: JudgeSettings;
  /**
   * How far each session has been judged, as a **byte offset**.
   *
   * Not a parser version and not a boolean. A live session keeps growing, so
   * "judged" is a position rather than a state — key it any other way and a
   * session is judged once at turn 50 and never again at turn 800.
   */
  ledger: Record<string, number>;
  findings: JudgedFinding[];
  /**
   * What the judge has spent, in tokens, cumulatively.
   *
   * Tokens and never dollars: a price depends on plan, tier and model, and on
   * a subscription it is notional. We report what we can actually know.
   */
  usage: { calls: number; inputTokens: number; outputTokens: number };
};

export function emptyState(): JudgeState {
  return {
    v: VERSION,
    settings: { ...DEFAULT_SETTINGS },
    ledger: {},
    findings: [],
    usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
  };
}

function pathFor(archive: string): string {
  return join(archive, 'judge.json');
}

/**
 * Read it, or a fresh one. A corrupt file must not stop a session starting.
 *
 * ── Why a version bump migrates instead of resetting ───────────────────────
 *
 * This used to be `if (raw.v !== VERSION) return emptyState()`, which on any
 * schema change would have done two things nobody would have chosen:
 *
 * 1. **Silently revoked consent.** `enabled` defaults to false, so a user who
 *    had explicitly run `judge --enable --apply` would find the judge off, with
 *    nothing said. The whole point of the flag at the top of this file is that
 *    turning it on is a deliberate act; turning it off must be one too.
 * 2. **Spent their money again.** Wiping `ledger` re-judges every session from
 *    byte 0. On this machine that is a few hundred thousand tokens for findings
 *    already paid for once.
 *
 * So the two fields a user cannot recreate — their consent and what they have
 * already paid for — are carried across unconditionally, and only `findings`
 * are dropped when their shape is no longer readable. A finding is cheap to
 * re-derive; a ledger entry is not, and consent is not ours to reset.
 *
 * A file from the future (`v` greater than ours) is left alone the same way: we
 * keep its settings and ledger and drop findings we cannot parse, rather than
 * overwriting a newer tool's state.
 */
export function readJudgeState(archive: string): JudgeState {
  try {
    const raw = JSON.parse(readFileSync(pathFor(archive), 'utf8')) as Partial<JudgeState>;
    const state = {
      ...emptyState(),
      ...raw,
      v: VERSION,
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
      ledger: { ...(raw.ledger ?? {}) },
      usage: { ...emptyState().usage, ...(raw.usage ?? {}) },
      findings: Array.isArray(raw.findings) ? raw.findings.filter(isReadableFinding) : [],
    } as JudgeState;
    return state;
  } catch {
    return emptyState();
  }
}

/**
 * The fields every version has had, and which `renderJudged` needs.
 *
 * Deliberately minimal: a v1 finding has no `name` or `description`, and
 * dropping it for that would discard sound findings over a cosmetic absence.
 * What cannot be rendered is what cannot be *anchored* — no session, no turns,
 * no quote.
 */
function isReadableFinding(f: unknown): boolean {
  if (typeof f !== 'object' || f === null) return false;
  const r = f as Record<string, unknown>;
  return (
    typeof r['sessionId'] === 'string' &&
    typeof r['dimension'] === 'string' &&
    Array.isArray(r['turns']) &&
    typeof r['quote'] === 'string'
  );
}

/** Temp-then-rename, so a crash cannot leave half a ledger. */
export function writeJudgeState(archive: string, s: JudgeState): boolean {
  try {
    mkdirSync(archive, { recursive: true, mode: 0o700 });
    const tmp = `${pathFor(archive)}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, pathFor(archive));
    return true;
  } catch {
    return false;
  }
}

/**
 * Has enough new transcript arrived to be worth an invocation?
 *
 * Compared in **bytes**, because that is what the ledger stores and what is
 * cheap to check in a hook that must finish in milliseconds. The cadence is in
 * turns, so this converts with a deliberately rough constant — being slightly
 * early or late costs nothing, while reading the file to count turns would
 * cost the thing the hook cannot spend.
 */
export const BYTES_PER_TURN = 400;

export function dueForJudging(state: JudgeState, sessionId: string, sizeBytes: number): boolean {
  const judged = state.ledger[sessionId] ?? 0;
  return sizeBytes - judged >= state.settings.cadence * BYTES_PER_TURN;
}

/**
 * How long one model call takes, for estimating a pass.
 *
 * **Measured across three runs of very different sizes**, which is why it is a
 * constant rather than a guess:
 *
 * ```
 *    35 calls / 20 min  =  34s
 *    98 calls / 50 min  =  31s
 *   195 calls / 95 min  =  29s
 * ```
 *
 * Two-stage pays this twice per batch — stage A reads the transcripts, stage B
 * reads the records it produced — so a batch is about a minute.
 */
export const JUDGE_SECONDS_PER_CALL = 30;

/**
 * Seconds as something a person can plan around.
 *
 * Deliberately coarse. "about 4 minutes" is honest about an estimate built
 * from a per-call average; "4m 12s" would imply a precision it does not have.
 */
export function humanDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} seconds`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = seconds / 3600;
  return `${hours.toFixed(hours < 10 ? 1 : 0)} hours`;
}

/**
 * An estimate of the work a judge pass still has to do.
 *
 * Lives here, beside the ledger it reads, so `now`, `report` and
 * `judge --status` cannot drift into reporting different numbers for the same
 * state. It is a ceiling rather than a point prediction: a batch holds however
 * many sessions fit the token ceiling, so two calls per *session* is the
 * pessimistic end.
 */
export function pendingWork(
  state: JudgeState,
  sessions: { id: string; sizeBytes: number }[],
): { pending: number; judged: number; seconds: number } {
  let pending = 0;
  let judged = 0;
  for (const s of sessions) {
    if ((state.ledger[s.id] ?? 0) >= s.sizeBytes) judged += 1;
    else pending += 1;
  }
  return { pending, judged, seconds: pending * 2 * JUDGE_SECONDS_PER_CALL };
}

/**
 * Findings per dimension across the whole store.
 *
 * For the surfaces that summarise rather than list — the SessionStart block and
 * the report rollup. Lives here so every caller counts the same way.
 */
export function tallyByDimension(state: JudgeState): { dimension: string; count: number }[] {
  const by = new Map<string, number>();
  for (const f of state.findings) by.set(f.dimension, (by.get(f.dimension) ?? 0) + 1);
  return [...by].map(([dimension, count]) => ({ dimension, count }));
}

/** Findings for one session, newest first. */
export function findingsFor(state: JudgeState, sessionId: string): JudgedFinding[] {
  return state.findings
    .filter((f) => f.sessionId === sessionId)
    .sort((a, b) => b.at.localeCompare(a.at));
}
