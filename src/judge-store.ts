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

import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { JudgeDimension } from './judge.ts';
import {
  addSpend, advanceLedger, openStore, putEvidence, putOccurrences, readSpend, transact, type Db,
} from './store.ts';
import { createHash } from 'node:crypto';

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
  // The principle survives intact because the consent moved rather than
  // vanished: installing the plugin is the act, and the one-time notice at
  // session start states what will be spent before anything is.
  //
  // This paragraph used to say the opposite — *"nothing is judged until the
  // user runs a command, the `Stop` hook no longer spawns a pass"* — and
  // pointed at a `cmdNow` that no longer exists. Both halves were inverted by
  // the producer/reader split: the `Stop` hook is the **only** automatic
  // spawner, and no command spends at all. `test/spend-boundary.test.ts`
  // asserts exactly that, so the code was right and the comment was lying.
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
  /**
   * Set when the store could not be opened or read.
   *
   * Without it, a failed read is indistinguishable from an empty store, and
   * every count above reads as a fact. A surface that shows a number must
   * check this first and say what it does not know.
   */
  storeUnreadable?: boolean;
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

/**
 * Settings live alone, and that is the fix for the consent race.
 *
 * They used to share `judge.json` with the ledger, the findings and the usage
 * counters — so a pass, which holds whole state in memory for up to six
 * minutes, would rewrite a user's `enabled: false` back to `true` on the way
 * out. The user turns the model off and the tool turns it on, silently.
 *
 * **No producer opens this file.** A pass cannot undo a decision it never
 * reads, which is a stronger guarantee than any amount of locking.
 */
function settingsPath(archive: string): string {
  return join(archive, 'judge-settings.json');
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
  return {
    v: VERSION,
    settings: readSettings(archive),
    ...readProgress(archive),
  };
}

/** Just the consent half. Cheap, and the only part a hook needs synchronously. */
export function readSettings(archive: string): JudgeSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(archive), 'utf8')) as Partial<JudgeSettings>;
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Write the settings, and only the settings.
 *
 * The one write in the judge path that a user initiates, so it is the one
 * write that must never be clobbered by a background pass.
 */
export function writeSettings(archive: string, settings: JudgeSettings): boolean {
  try {
    mkdirSync(archive, { recursive: true, mode: 0o700 });
    const tmp = `${settingsPath(archive)}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, settingsPath(archive));
    return true;
  } catch {
    return false;
  }
}

/** The ledger, findings and spend, read out of the store. */
function readProgress(archive: string): Omit<JudgeState, 'v' | 'settings'> {
  let db: Db | undefined;
  try {
    db = openStore(archive);
    const spend = readSpend(db);
    const ledger: Record<string, number> = {};
    for (const row of db.prepare('SELECT session_id, judged_bytes FROM ledger').all()) {
      ledger[String(row['session_id'])] = Number(row['judged_bytes']);
    }
    return {
      ledger,
      findings: readJudgedFindings(db),
      usage: { calls: spend.calls, inputTokens: spend.tokensIn, outputTokens: spend.tokensOut },
    };
  } catch {
    // ── Not throwing is correct. Returning a bare zero is not ──────────────
    //
    // Principle Zero means an unreadable store must not stop a session, so
    // this cannot rethrow. But the value it returned was **identical to an
    // empty store**, so `judge --status` printed `judged 0 session(s) · 0
    // finding(s)` over a database it had failed to open — turning "I could not
    // read this" into "there is nothing here".
    //
    // That is the project's own `inaccurate_self_report` dimension, in its own
    // status output, and `unknown` beats guessing: the flag lets a caller say
    // what is true instead of asserting a count it does not have.
    return {
      ledger: {},
      findings: [],
      usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
      storeUnreadable: true,
    };
  } finally {
    db?.close();
  }
}

/**
 * Judge findings, reassembled from the fact table.
 *
 * Grouped by occurrence id, because one finding cites several turns and the
 * store keeps one row per anchored turn — which is the grain that lets the
 * same data answer "how many files" and "which sessions" as well.
 */
function readJudgedFindings(db: Db): JudgedFinding[] {
  const rows = db
    .prepare(
      `SELECT o.id, o.session_id, o.dimension, o.reason, o.at, e.anchor, e.quote
       FROM occurrence o LEFT JOIN evidence e ON e.occurrence_id = o.id
       WHERE o.tier = 'judge' ORDER BY o.at DESC`,
    )
    .all();

  const by = new Map<string, JudgedFinding & { turns: number[] }>();
  for (const r of rows) {
    const id = String(r['id']);
    let f = by.get(id);
    if (f === undefined) {
      f = {
        sessionId: String(r['session_id']),
        dimension: String(r['dimension']) as JudgedFinding['dimension'],
        turns: [],
        why: r['reason'] === null ? '' : String(r['reason']),
        at: String(r['at']),
        ...(r['quote'] === null || r['quote'] === undefined ? {} : { quote: String(r['quote']) }),
      };
      by.set(id, f);
    }
    const seq = Number(r['anchor']);
    if (Number.isFinite(seq)) f.turns.push(seq);
  }
  return [...by.values()];
}

/**
 * Record a pass's results: findings and the watermark, together.
 *
 * ── Why these two and nothing else ─────────────────────────────────────────
 *
 * The function this replaces wrote **whole state** — settings, ledger,
 * findings and usage — four times per pass, from a copy read up to six
 * minutes earlier. That is where every race came from. A producer now writes
 * only what it produced:
 *
 * - **not settings**, so a user's `--disable` cannot be undone
 * - **not spend**, which is recorded separately the moment a call returns,
 *   because we paid whether or not anything downstream succeeded
 *
 * Findings and the watermark go in one transaction, because a watermark means
 * *"we have results for these bytes"*. Advancing it first — which this project
 * did, with a comment accepting the cost — loses paid-for episodes whenever
 * the stage after it throws.
 */
export function recordPass(
  archive: string,
  findings: JudgedFinding[],
  offsets: Map<string, number>,
): boolean {
  let db: Db | undefined;
  try {
    db = openStore(archive);
    transact(db, () => {
      if (findings.length > 0) {
        putOccurrences(
          db as Db,
          findings.map((f) => ({
            id: judgedFindingId(f),
            sessionId: f.sessionId,
            dimension: f.dimension,
            tier: 'judge' as const,
            subject: f.name ?? f.dimension,
            confidence: f.confidence ?? 'likely',
            reason: f.why,
            at: f.at,
          })),
        );
        putEvidence(
          db as Db,
          findings.flatMap((f) =>
            f.turns.map((t) => ({
              occurrenceId: judgedFindingId(f),
              anchor: String(t),
              // The judge cites turn numbers; its quote is what validates the
              // citation. Rule findings anchor by uuid instead — see D24.
              kind: 'turn' as const,
              ...(f.quote === undefined ? {} : { quote: f.quote }),
            })),
          ),
        );
      }
      for (const [id, off] of offsets) advanceLedger(db as Db, id, off);
    });
    return true;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/**
 * Record what a call cost, on its own.
 *
 * Deliberately outside any transaction that could roll back: the money left
 * the account when the call returned, and a figure that under-reports what we
 * charged someone is worse than no figure.
 */
export function recordSpend(
  archive: string,
  delta: { calls?: number; tokensIn?: number; tokensOut?: number },
): void {
  let db: Db | undefined;
  try {
    db = openStore(archive);
    addSpend(db, delta);
  } catch {
    // Never worth failing a pass over.
  } finally {
    db?.close();
  }
}

/**
 * A stable id for a judge finding.
 *
 * Content-hashed, which is what makes a retried pass idempotent: the same
 * episode produces the same id and upserts over itself instead of duplicating.
 */
function judgedFindingId(f: JudgedFinding): string {
  return createHash('sha256')
    .update(`judge\0${f.sessionId}\0${f.dimension}\0${f.quote ?? f.why.slice(0, 120)}`)
    .digest('hex')
    .slice(0, 16);
}

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
): { pending: number; judged: number; unread: number; behind: number; seconds: number } {
  // ── Three states, because "pending" was two of them ──────────────────────
  //
  // This counted a session as judged only when `ledger >= sizeBytes`, and
  // everything else as pending. Two very different facts were landing in that
  // one bucket:
  //
  //   unread   never looked at — nothing of it has ever been read
  //   behind   read, then the session grew, so there are newer bytes
  //
  // The distinction is not academic. **A live session is permanently
  // "behind"**: it grows as you work, so the moment a pass finishes there are
  // new bytes again. Reporting that as pending made the status read
  // `judged 0 session(s)` on a machine where two sessions had in fact been
  // read and had produced findings — and made the count something that can
  // never reach zero while anyone is using the tool.
  //
  // Only `unread` is what a person means by "not analysed yet", so only
  // `unread` drives the estimate.
  let unread = 0;
  let behind = 0;
  let judged = 0;
  for (const s of sessions) {
    const at = state.ledger[s.id] ?? 0;
    if (at >= s.sizeBytes) judged += 1;
    else if (at === 0) unread += 1;
    else behind += 1;
  }
  return {
    // "Has work outstanding" — both states do, and `seconds` must cover both.
    // Scoping the estimate to `unread` was wrong and a test said so by name:
    // a grown session still costs two calls to catch up on.
    pending: unread + behind,
    judged,
    // What a person means by "not analysed yet". Only this drives the count a
    // user reads, because a live session is permanently `behind` and a number
    // including it could never reach zero.
    unread,
    behind,
    seconds: (unread + behind) * 2 * JUDGE_SECONDS_PER_CALL,
  };
}

/**
 * The session to read next when the live one has nothing new.
 *
 * Oldest-first and **never-read only**. Picking the oldest *pending* session
 * would keep returning to ones already mostly covered — a live session is
 * always pending — while sessions nobody has ever looked at wait behind them.
 */
export function oldestUnread(
  state: JudgeState,
  sessions: { id: string; sizeBytes: number; mtimeMs?: number }[],
): string | undefined {
  const unread = sessions
    .filter((s) => (state.ledger[s.id] ?? 0) === 0 && s.sizeBytes > 0)
    .sort((a, b) => (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0));
  return unread[0]?.id;
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

/**
 * A judge pass is slow enough to overlap itself.
 *
 * The ledger only advances once stage A returns — about thirty seconds — so
 * two `/agentsensei:insights` calls inside that window both see the same offset,
 * both decide the session is due, and **both spend ~58k tokens on the same
 * bytes.** Measured: two invocations produced two independent passes.
 *
 * Shaped like `standing.running`: a marker written before the spawn, removed
 * when the pass exits, and aged out so a crashed pass cannot block the next
 * one for ever. Five minutes, because a batch is about a minute and the
 * failure mode of being slightly too cautious is a delayed finding, where the
 * failure mode of being too eager is a duplicate bill.
 */
export const JUDGE_RUNNING_STALE_MS = 5 * 60 * 1000;

const RUNNING = 'judge.running';

export function judgeRunning(archive: string, now = Date.now()): boolean {
  try {
    return Math.abs(now - statSync(join(archive, RUNNING)).mtimeMs) < JUDGE_RUNNING_STALE_MS;
  } catch {
    return false;
  }
}

export function markJudgeRunning(archive: string): void {
  try {
    mkdirSync(archive, { recursive: true, mode: 0o700 });
    writeFileSync(join(archive, RUNNING), `${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch {
    // Worst case two passes overlap once. Never worth failing a command over.
  }
}

export function clearJudgeRunning(archive: string): void {
  try {
    rmSync(join(archive, RUNNING), { force: true });
  } catch {
    // Staleness covers this.
  }
}

/**
 * Has the one-time spend disclosure been shown on this machine?
 *
 * Lives here rather than in the CLI because the producer moved: the first
 * spend now happens in a hook, and the notice has to surface through the
 * session-start block, which is the one channel that reaches a user.
 *
 * A marker file rather than a field in `judge.json`, for the same reason
 * `standing.running` is one: it is a fact about this installation, not part of
 * the judge's persisted state, and it must not be lost to a schema migration
 * or re-shown because a store was rebuilt.
 */
export function hasDisclosed(archive: string): boolean {
  return existsSync(join(archive, 'disclosed'));
}

export function markDisclosed(archive: string): void {
  try {
    mkdirSync(archive, { recursive: true, mode: 0o700 });
    writeFileSync(join(archive, 'disclosed'), new Date().toISOString(), { mode: 0o600 });
  } catch {
    // Worst case the notice shows twice. Never worth failing a command over.
  }
}

/** Findings for one session, newest first. */
export function findingsFor(state: JudgeState, sessionId: string): JudgedFinding[] {
  return state.findings
    .filter((f) => f.sessionId === sessionId)
    .sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * What to say about analysis that has not finished, in the unit that governs it.
 *
 * ── Why this is not minutes ────────────────────────────────────────────────
 *
 * The old line was `about 25 minutes at ~30s per call`, and the one on the
 * session surface was `humanDuration(2 * JUDGE_SECONDS_PER_CALL)` — which
 * evaluates to the constant string "60 seconds" whatever is happening.
 *
 * Both reported **compute time** to a reader who will hear wall-clock time.
 * What actually paces completion is turn boundaries: the `Stop` hook reads one
 * session per idle one, so the same 25 minutes of model time is an afternoon
 * or three days depending on how much someone works.
 *
 * A real duration is given for exactly one case — a pass in flight, where
 * elapsed-against-expected is a fact rather than an extrapolation.
 */
export function progressLine(
  opts: {
    unread: number;
    running?: { sessionId?: string; elapsedMs: number };
    callMs?: number;
    /**
     * A pass has been spawned but has not recorded itself yet.
     *
     * The marker is written by the **spawner** and the `run` row by the pass,
     * so between the two there is a real window where something is running and
     * nothing can say for how long. Saying so beats saying nothing.
     */
    spawned?: boolean;
  },
): string {
  const { unread, running } = opts;

  if (running === undefined && opts.spawned === true) return 'Reading a session now.';

  if (running !== undefined) {
    const expected = (opts.callMs ?? JUDGE_SECONDS_PER_CALL * 1000) * 2;
    const left = Math.max(expected - running.elapsedMs, 0);
    // Past the estimate it says so rather than counting into the negative or
    // freezing at "any moment now": overrunning is information too.
    const when = left > 0 ? `about ${humanDuration(Math.round(left / 1000))} left` : 'nearly done';
    return `Reading a session now — ${when}.`;
  }

  if (unread === 0) return '';
  return `${unread} session${unread === 1 ? '' : 's'} still to read, about one per turn as you work.`;
}

/**
 * How far the analysis has got, and how much is left — as a block.
 *
 * ── Why the user could not see an ETA ──────────────────────────────────────
 *
 * There was one, and it only ever appeared while a pass was mid-flight, which
 * is a window of about a minute that nobody happens to be looking at. Every
 * other time the surfaces said how much was *outstanding* and never how much
 * was *done*, so there was no number to watch move.
 *
 * Progress is the thing a person can act on: `3 of 30 read` tells you it is
 * working, where `27 still to read` could equally mean nothing ever happens —
 * which, until the backlog started draining, it did.
 *
 * The minutes are honest if qualified. 27 sessions is ~27 minutes of model
 * time; what converts that to wall-clock is how much you work, because the
 * `Stop` hook reads one per idle turn boundary. Said plainly rather than
 * hidden, because a reader who wants an ETA is owed a number.
 */
export function analysisBlock(opts: {
  total: number;
  read: number;
  unread: number;
  running?: { sessionId?: string; elapsedMs: number };
  callMs?: number;
  spawned?: boolean;
}): string[] {
  const { total, read, unread } = opts;
  if (total === 0) return [];

  const head = `${read} of ${total} session${total === 1 ? '' : 's'} read`;
  if (unread === 0 && opts.running === undefined) {
    return [head, 'Up to date.'];
  }

  const now = progressLine({
    unread,
    ...(opts.running === undefined ? {} : { running: opts.running }),
    ...(opts.callMs === undefined ? {} : { callMs: opts.callMs }),
    ...(opts.spawned === true ? { spawned: true } : {}),
  });

  // Model time, stated as such. The per-call figure is measured where we have
  // it and falls back to the constant until three passes exist.
  const perSession = ((opts.callMs ?? JUDGE_SECONDS_PER_CALL * 1000) * 2) / 1000;
  const left = humanDuration(Math.round(unread * perSession));

  return opts.running !== undefined
    ? [head, now]
    : [head, `about ${left} of reading left, done in the background as you work`];
}
