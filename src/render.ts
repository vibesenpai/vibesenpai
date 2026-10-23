/**
 * Findings, rendered for a person.
 *
 * ── Two outputs, never a third ──────────────────────────────────────────────
 *
 * CLAUDE.md allows evidence and something applicable. So every finding here
 * shows the turns it is about and, where the harness named a reason, the one
 * line that follows from it. Nothing else earns space.
 *
 * ── What this module refuses to print ──────────────────────────────────────
 *
 * **No score, no total, no grade.** Not a stylistic preference: an unexplained
 * number is the thing this project exists as an alternative to, and the moment
 * a total exists people optimise it instead of reading the evidence.
 *
 * **No severity words and no imperative verbs in the finding itself.** The
 * subject line states what happened; the advice line, which comes from the
 * harness's own reason, says what follows. "3 edits were refused, then retried"
 * is a fact. "Fix your edit discipline" is a nag, and a nag from a tool that is
 * wrong 1% of the time gets uninstalled.
 *
 * **Nothing it cannot source.** A reason the harness did not give prints as
 * `(reason unknown)` rather than being guessed at or omitted — omitting it
 * would imply the finding had no reason, which is a different claim.
 *
 * ── Plain text, deliberately ───────────────────────────────────────────────
 *
 * No colour. The output is read in terminals we do not control, piped into
 * files, and pasted into issues; ANSI codes survive none of that well. Emphasis
 * comes from layout, which survives everything.
 */

import { basename } from 'node:path';
import type { Denominators } from './detect/index.ts';
import type { Event, Finding } from './types.ts';
import { adviceFor, reasonOf, type Reason } from './detect/labels.ts';
import { sessionStats, type SessionStats } from './stats.ts';
import { approx, costFor } from './cost.ts';
import { bold, dim, pad, red, rule, yellow } from './style.ts';

/**
 * Corpus percentiles, kept for the surfaces that still use them.
 *
 * **No longer rendered here.** `renderCost` compared a session against these
 * and printed `corpus median 17.9` at the reader — a figure measured over
 * 1,132 SWE-chat sessions, which is to say other people's, hand-copied from
 * `npm run measure`. It is now measured against the reader's own history.
 *
 * Still imported by `report-line.ts`, where it is a **silent gate** rather
 * than a displayed number, and by `html.ts`.
 */
export const CORPUS = {
  /**
   * `cacheCreation / output` per session, measured over 1,132 SWE-chat
   * sessions. Quoted rather than used as a threshold: this module states where
   * a session sits, it does not judge it.
   *
   * **Re-measured after the per-response token fix.** These were 12.0 and 93.4,
   * computed while a split response's `usage` was summed once per record. Both
   * halves of the ratio were inflated, but not equally — output by 3.7x against
   * cache creation's 2.8x — so the ratio itself was wrong by about a third.
   */
  reingestP50: 17.9,
  reingestP90: 159.5,
} as const;

const INDENT = '  ';

/**
 * Report width.
 *
 * 68 plus the two-space indent fits inside 72, which leaves room in an 80-column
 * terminal for the gutter the harness adds when it echoes command output.
 */
const WIDTH = 68;

function human(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * A duration, or undefined when the span is not knowable.
 *
 * Undefined rather than `0m`: a session whose timestamps we could not read is a
 * different thing from a session that took no time.
 */
/**
 * A gap longer than this is someone having lunch, not working slowly.
 *
 * Half an hour is deliberately generous: the cost of over-counting a long
 * think is a minute or two, and the cost of under-counting is telling someone
 * their afternoon took ten minutes.
 */
export const IDLE_GAP_MS = 30 * 60 * 1000;

/**
 * Time actually spent in a session, as `durationOf` would format it.
 *
 * Returns `undefined` when there is nothing to measure, which the caller
 * renders by saying nothing rather than by saying zero.
 */
export function activeDuration(events: Event[]): string | undefined {
  const ts = events
    .map((e) => Date.parse(e.ts ?? ''))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (ts.length < 2) return undefined;

  let active = 0;
  for (let i = 1; i < ts.length; i++) {
    const gap = (ts[i] as number) - (ts[i - 1] as number);
    if (gap < IDLE_GAP_MS) active += gap;
  }
  if (active === 0) return undefined;
  // `durationOf` floors to whole minutes, so twenty seconds of real work came
  // back as `0m` — which reads as a bug rather than as a short session.
  if (active < 60_000) return 'under a minute';
  const start = new Date(0).toISOString();
  return durationOf(start, new Date(active).toISOString());
}

/** `3d0h` → `3 days`, `1h30m` → `1h30m`. Prose only; the compact form stays. */
function proseDuration(d: string | undefined): string | undefined {
  if (d === undefined) return undefined;
  const days = /^(\d+)d/.exec(d);
  if (days === null) return d;
  const n = Number(days[1]);
  return `${n} day${n === 1 ? '' : 's'}`;
}

export function durationOf(from: string | undefined, to: string | undefined): string | undefined {
  if (from === undefined || to === undefined) return undefined;
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h${String(mins % 60).padStart(2, '0')}m`;
  // Days past two, because a resumed session genuinely spans them and `174h21m`
  // is a number nobody reads as a week.
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

/**
 * Shorten a path from the left, keeping the end.
 *
 * The tail is what identifies a file; the prefix is shared by everything in the
 * project and is the least informative part of the string.
 */
export function shortenPath(path: string, max = 68): string {
  if (path.length <= max) return path;
  return `…${path.slice(-(max - 1))}`;
}

/**
 * What this user's sessions normally look like, so a number has a reference
 * point they can actually check.
 *
 * `ratio` **excludes the session being described**. On the machine this was
 * written for, one session was 6.8M of a 22.4M total — 30% — so comparing it
 * against an aggregate containing it would have been comparing it partly to
 * itself.
 */
export type Baseline = { ratio: number; sessions: number };

/**
 * How many other sessions it takes before "your usual" means anything.
 *
 * Below this we say the fact and stop. We never fall back to the corpus
 * figures: a baseline the reader cannot inspect is the thing being fixed.
 */
export const BASELINE_MIN_SESSIONS = 5;

/** How far above their usual a session has to be before it is worth a sentence. */
export const NOTABLE_MULTIPLE = 2;

export type RenderInput = {
  findings: Finding[];
  denominators: Denominators;
  /** This user's own history, minus this session. Absent when too new to have one. */
  baseline?: Baseline;
  /** Shown so a reader can tell an empty result from an unanalysed one. */
  sessionId: string;
  /** Model-flagged findings for this session, and how stale they are. */
  judged?: {
    findings: { dimension: string; turns: number[]; why: string }[];
    unjudgedTurns: number;
    /** Rough wall-clock for the outstanding work, already formatted. */
    eta?: string;
  };
  /**
   * The pointer to `fix`, printed last.
   *
   * Passed in rather than built here because deciding it needs the filesystem —
   * whether the command is installed — and this module is pure. The CLI owns
   * that check, through `fixLine`.
   *
   * Omitted when there is nothing to act on: no findings here and none in
   * history means nothing to fix, so nothing to offer.
   */
  nextStep?: string;
  /**
   * The session's events, so each cited turn can say what happened there.
   *
   * A finding carries `TurnRef`s, which are uuids and positions — enough to
   * locate a turn and not enough to read one. Bare turn numbers technically
   * satisfy "points at specific turns" while making a person open the
   * transcript to learn anything, which is a weak reading of the evidence
   * principle. The events are what turn a citation into something checkable
   * in place.
   */
  events: Event[];
  /** Dimensions the user silenced. Named, so silence is never mysterious. */
  muted?: string[];
};

/**
 * The time a session spans, from the extremes rather than the ends.
 *
 * File order is not time order: a `/rewind` leaves earlier records after later
 * ones, which made last-minus-first negative and the duration vanish.
 */
export function spanOf(events: Event[]): { first?: string; last?: string } {
  let first: string | undefined;
  let last: string | undefined;
  for (const e of events) {
    if (e.ts === undefined) continue;
    if (first === undefined || e.ts < first) first = e.ts;
    if (last === undefined || e.ts > last) last = e.ts;
  }
  return {
    ...(first !== undefined ? { first } : {}),
    ...(last !== undefined ? { last } : {}),
  };
}

/**
 * One cited turn, said in a way a person can check.
 *
 * Display tier, so reading `textSummary` here is allowed where a detector may
 * not — the parser has already redacted it, and a wrong label costs a confusing
 * line rather than a wrong finding.
 */
export function describeTurn(e: Event): string {
  switch (e.turnType) {
    case 'tool_use': {
      const target = e.filePath ?? e.pattern ?? e.command ?? '';
      const tail = target === '' ? '' : `  ${shortenPath(target.replace(/\s+/g, ' '), 46)}`;
      return `${(e.toolName ?? 'tool').padEnd(10)}${tail}`;
    }
    case 'tool_result': {
      if (e.isError !== true) return 'ok';
      // The harness's own words, where we recognise them; otherwise its text,
      // clipped. Never a guess at what went wrong.
      const reason = reasonOf(e);
      if (reason !== undefined) return `${'refused'.padEnd(10)}  ${reason}`;
      const raw = (e.textSummary ?? '').replace(/\s+/g, ' ').replace(/^<tool_use_error>/, '');
      return `${'failed'.padEnd(10)}  ${raw.slice(0, 46)}`;
    }
    case 'user_prompt':
      return 'you';
    case 'assistant_msg':
      return 'assistant';
    default:
      return e.turnType;
  }
}

/**
 * The evidence block for one finding.
 *
 * Turn numbers are printed because they are what makes a finding checkable —
 * someone can open the transcript and see for themselves, which is the whole
 * difference between this and a score.
 */
/**
 * One evidence row, as data rather than text.
 *
 * Shared with `src/html.ts`, which is why this is a structure and not a
 * formatted string: the HTML report builds the same table from the same rows,
 * and — importantly — it means the gather step can keep these and **discard the
 * events**. Retaining every session's events to look up six cited turns each
 * would hold the whole history in memory at once.
 */
export type EvidenceRow = {
  turn: string;
  what: string;
  detail: string;
  /** The tool refused. Rendered `✗` in the terminal, a class in HTML. */
  failed: boolean;
  /** The call straight after a refusal — the retry a reader would infer. */
  retry: boolean;
};

export function evidenceRows(f: Finding, byUuid: Map<string, Event>, max = 6): EvidenceRow[] {
  const rows: EvidenceRow[] = [];
  let prevFailed = false;

  for (const ref of f.evidence.slice(0, max)) {
    const e = byUuid.get(ref.uuid);
    const turn = ref.seq === undefined ? '?' : String(ref.seq);
    if (e === undefined) {
      rows.push({ turn, what: '', detail: '', failed: false, retry: false });
      prevFailed = false;
      continue;
    }
    const failed = e.turnType === 'tool_result' && e.isError === true;
    // "Edit, refused, Edit" is the whole shape of the finding, and the third
    // row is the one a reader has to infer. Marked so they do not have to.
    const retry = e.turnType === 'tool_use' && prevFailed;
    const { what, detail } = turnColumns(e, f.subject);
    rows.push({ turn, what, detail, failed, retry });
    prevFailed = failed;
  }
  return rows;
}

function evidenceLines(f: Finding, byUuid: Map<string, Event>, max = 6): string[] {
  const shown = f.evidence.slice(0, max);
  const rows = evidenceRows(f, byUuid, max);

  // Widths measured from the rows actually shown: the previous version
  // hard-coded a pad of 5, so a four-digit turn pushed its line out of column.
  const turnW = Math.max(...rows.map((r) => r.turn.length));
  const whatW = Math.max(...rows.map((r) => r.what.length + (r.failed ? 2 : 0)));

  const out = rows.map((r) => {
    const marker = r.failed ? `${red('✗')} ` : '';
    const detail = r.retry
      ? `${dim('↻')} ${r.detail === '' ? dim('retried') : r.detail}`
      : r.detail;
    const what = `${marker}${r.what}`;
    const raw = `${r.failed ? '✗ ' : ''}${r.what}`;
    return `${INDENT.repeat(2)}${pad(r.turn, turnW, bold, 'right')}  ${what}${' '.repeat(Math.max(0, whatW - raw.length))}  ${detail}`.trimEnd();
  });

  const hidden = f.evidence.length - shown.length;
  if (hidden > 0) {
    out.push(`${INDENT.repeat(2)}${' '.repeat(turnW)}  ${dim(`… ${hidden} more — agentsensei skeleton`)}`);
  }
  return [...out, ''];
}

/**
 * One evidence row, split into its two columns.
 *
 * **The subject is not repeated.** A finding about one file printed that path in
 * the header and again on every tool row — seven times in the block this was
 * written against. The path still shows when a row touches a *different* file,
 * which is the case where it carries information.
 */
function turnColumns(e: Event, subject: string): { what: string; detail: string } {
  switch (e.turnType) {
    case 'tool_use': {
      const target = e.filePath ?? e.pattern ?? e.command ?? '';
      const same = target !== '' && (subject === target || subject.endsWith(target));
      return {
        what: e.toolName ?? 'tool',
        detail: same || target === '' ? '' : shortenPath(target.replace(/\s+/g, ' '), 40),
      };
    }
    case 'tool_result': {
      if (e.isError !== true) return { what: 'ok', detail: '' };
      const reason = reasonOf(e);
      if (reason !== undefined) return { what: 'refused', detail: reason };
      const raw = (e.textSummary ?? '').replace(/\s+/g, ' ').replace(/^<tool_use_error>/, '');
      return { what: 'failed', detail: raw.slice(0, 40) };
    }
    case 'user_prompt':
      return { what: 'you', detail: '' };
    case 'assistant_msg':
      return { what: 'assistant', detail: '' };
    default:
      return { what: e.turnType, detail: '' };
  }
}

/** The reason tally as advice lines, widest reason name first for alignment. */
/**
 * The qualifier on a finding, when there is one — otherwise nothing.
 *
 * ── Why `[certain]` is gone ────────────────────────────────────────────────
 *
 * It was printed on every finding, because every live detector is a rule and
 * every rule emits `certain`. A label with one possible value tells a reader
 * nothing, and "certain" in particular reads as a boast about a tool that
 * should be understating itself.
 *
 * **CLAUDE.md still holds**: the UI must never blur "flagged by rule" and
 * "flagged by a model at 0.7". That rule is about not hiding a *weaker* claim,
 * and it is satisfied better this way. Silence now means the strongest case —
 * a rule, no doubt — so anything less than that has to say so, in words rather
 * than a severity token:
 *
 * ```
 *   RULE  + certain    (nothing)
 *   RULE  + high       "the output was clipped, so this is a close match"
 *   JUDGE + anything   "flagged by a model"
 * ```
 *
 * When the model-backed detectors land they will be visibly distinct, which is
 * the whole point of the rule — and they will be distinct because they are
 * *marked*, not because the rule-based ones carry a badge too.
 */
const MODEL_METHODS = new Set(['LEX', 'EMB', 'CLS', 'NLI', 'JUDGE']);

export function caveatFor(f: Finding): string {
  if (MODEL_METHODS.has(f.method)) {
    return f.confidence === 'certain' ? 'flagged by a model' : `flagged by a model · ${f.confidence}`;
  }
  switch (f.confidence) {
    case 'certain':
      return '';
    case 'high':
      // The only way a rule reaches this today: `redundant_call` compared a
      // clipped output, so "the same answer" is a weaker claim than usual.
      return 'close match — compared output was clipped';
    default:
      return `${f.confidence} confidence`;
  }
}

/**
 * How a finding's subject is named.
 *
 * A path shows as a path. A digest-suffixed subject — which is what
 * `redundant_call` produces when there is no readable target — is replaced by
 * the command itself, read from the evidence. Allowed here and nowhere else:
 * this is the display tier.
 */
export function headlineFor(f: Finding, byUuid: Map<string, Event>): string {
  const digest = /#[0-9a-f]{4,}$/.exec(f.subject);
  if (digest === null) return shortenPath(f.subject);
  const first = f.evidence.map((r) => byUuid.get(r.uuid)).find((e) => e?.command !== undefined);
  if (first?.command === undefined) return f.subject;
  return `${shortenPath(first.command.replace(/\s+/g, ' '), 56)}  ${digest[0]}`;
}

/** The reason tally, reason column aligned so the dominant one is scannable. */
function adviceLines(f: Finding): string[] {
  const reasons = Object.entries(f.reasons ?? {});
  if (reasons.length === 0) return [`${INDENT.repeat(2)}${dim('(reason unknown)')}`, ''];
  const sorted = reasons.sort((a, b) => b[1] - a[1]);
  const width = Math.max(...sorted.map(([k, n]) => k.length + (n > 1 ? String(n).length + 2 : 0)));
  const out = sorted.map(([reason, n]) => {
    const count = n > 1 ? ` ×${n}` : '';
    const raw = `${reason}${count}`;
    // The reason is the finding's own label; the advice beside it is guidance,
    // so it is dimmed. Keeps the eye on which reason dominated.
    return `${INDENT.repeat(2)}${pad(raw, width, (t) => t.replace(count, dim(count)))}  ${dim(adviceFor(reason as Reason) ?? '')}`.trimEnd();
  });
  return [...out, ''];
}

export function renderFinding(
  f: Finding,
  byUuid: Map<string, Event> = new Map(),
  events: Event[] = [],
): string[] {
  const times = f.occurrences > 1 ? ` ×${f.occurrences}` : '';
  const caveat = caveatFor(f);
  const head =
    `${INDENT}${bold(f.dimension)}${times === '' ? '' : dim(times)}` +
    (caveat === '' ? '' : `  ${dim(caveat)}`);

  return [
    head,
    `${INDENT}${rule(WIDTH)}`,
    // The cost sits directly under the header because it is the "so what".
    // Before, it was the last thing in the block — below six evidence rows —
    // which buried the one number a reader is most likely to act on.
    ...costLines(f, events),
    `${INDENT}${yellow(headlineFor(f, byUuid))}`,
    ...adviceLines(f),
    ...evidenceLines(f, byUuid),
  ];
}

/**
 * What this finding cost, in tokens.
 *
 * **Two numbers, never one total.** `written` is output the agent generated and
 * discarded — expensive per token and the honest headline. `carried` is what
 * keeping that text in context cost afterwards, which is cache reads at roughly
 * a tenth the price of input. Measured on real sessions, 98% of context tokens
 * are cache reads, so adding the two would be meaningless arithmetic.
 *
 * Absent entirely when nothing could be priced — a session parsed before
 * `argBytes` existed, or a finding whose calls carry no sizes. `0 tokens` would
 * claim a measurement that was not made.
 */
export function costLines(f: Finding, events: Event[]): string[] {
  if (events.length === 0) return [];
  const c = costFor(events, { dimension: f.dimension, subject: f.subject });
  if (c.written + c.received === 0) return [];

  // `[figure, label, note]`, so the figures share one right-aligned column and
  // compare at a glance. Rows with nothing to report are dropped rather than
  // printed as zero.
  const rows: [string, string, string][] = [[approx(c.written), 'tokens written and discarded', '']];
  if (c.received > 0) rows.push([approx(c.received), 'received back', '']);
  if (c.carriedTurns > 0) {
    rows.push([
      approx(c.carried),
      `cache reads over ${c.carriedTurns} request${c.carriedTurns === 1 ? '' : 's'}`,
      '0.1× input',
    ]);
  }

  const w = Math.max(...rows.map(([n]) => n.length));
  const out = rows.map(
    ([n, label, note]) =>
      `${INDENT.repeat(2)}${pad(n, w, bold, 'right')}  ${label}${note === '' ? '' : `  ${dim(note)}`}`,
  );
  return [...out, ''];
}

/**
 * What the session cost — a sentence, and only when it is news.
 *
 * ── What this used to print, and why it had to change ──────────────────────
 *
 *     1.7M out · 6.8M re-ingested · ratio 3.9 (corpus median 17.9)
 *
 * Three numbers, a word we invented, and a comparison against **1,132
 * SWE-chat sessions** — a public dataset the reader has never heard of and
 * cannot inspect. `report-line.ts` had already exempted this block from D62 on
 * the grounds that the ratio *"stays in `now`, where there is room to explain
 * it."* The intent was right; it never explained anything.
 *
 * So the baseline is now the reader's **own history**, which is the one
 * reference point they own, and the block appears only when this session is
 * genuinely unlike the rest of them. Presence is the signal — D62, applied
 * where it was previously waived.
 *
 * `cacheRead` is still deliberately absent. It re-counts the whole prefix on
 * every call, so it grows with the square of the turn count and any ratio built
 * on it is pinned near 1 by construction. Showing it would invite exactly the
 * reasoning GRAVEYARD.md records as the fifth instance of that mistake.
 */
export function renderCost(
  d: Denominators,
  stats?: SessionStats,
  baseline?: Baseline,
): string[] {
  const { output, cacheCreation } = d.tokens;
  if (output === 0) return [];

  const ratio = cacheCreation / output;

  // No baseline, no claim. A reader with four sessions has no "usual", and
  // inventing one from someone else's corpus is the defect being removed.
  if (baseline === undefined || baseline.sessions < BASELINE_MIN_SESSIONS) return [];
  if (ratio < baseline.ratio * NOTABLE_MULTIPLE) return [];

  const times = Math.round(ratio / baseline.ratio);
  const lines = [
    `${INDENT.repeat(2)}Claude re-read it ${bold(`${Math.round(ratio)}x`)} more than it wrote` +
      `${dim(` — about ${times}x your usual`)}`,
  ];

  // The anchored half. Measured: half a session's re-ingestion comes from 6% of
  // its turns, so naming the heaviest few is a ranking rather than a threshold.
  const heaviest = stats?.reingest.heaviest ?? [];
  if (heaviest.length > 1 && stats !== undefined && stats.reingest.share > 0) {
    const share = Math.round(stats.reingest.share * 100);
    lines.push(
      `${INDENT.repeat(3)}${dim(`${heaviest.length} turns account for ${share}% of that`)}`,
    );
  }
  return lines;
}

/**
 * The session's most-rewritten files.
 *
 * A ranking, so there is no threshold to defend, and no verb: this says what
 * changed most, never that changing it was wrong.
 *
 * The edit-call count is shown beside each path and **excludes nothing**. It is
 * how a reader tells a regenerated file from a worked one — but it undercounts
 * shell-driven edits, so it informs rather than decides. See `src/stats.ts`.
 */
export function renderRewritten(stats: SessionStats): string[] {
  const top = stats.rewritten[0];
  if (top === undefined) return [];

  // ── One line, and still no threshold ──────────────────────────────────────
  //
  // This was a five-row table headed `MOST REWRITTEN`, whose rows read
  // `93 versions  …/revert-churn.ts  no edit-tool calls` — which contradicts
  // itself to anyone who has not read `src/stats.ts`. It means the harness
  // recorded 93 versions of the file while we saw no Edit call for it, so the
  // writing happened some other way.
  //
  // Still a ranking and still no verb: this says what changed most, never that
  // changing it was wrong. That is why `file_churn` was rejected as a dimension
  // and this line was kept — see GRAVEYARD.md. Gating it on a threshold would
  // quietly turn the honest version into the rejected one.
  const name = basename(top.path);
  const how =
    top.editCalls === 0
      ? ', none from Claude editing it directly'
      : ` across ${top.editCalls} edit${top.editCalls === 1 ? '' : 's'}`;

  const lines = [
    `${INDENT.repeat(2)}${yellow(name)}${dim(` changed most — ${top.versions} versions${how}`)}`,
  ];
  // The tail carried the scale and pushed the line past a hundred columns. It
  // is a separate fact and reads as one.
  const others = stats.rewritten.length - 1;
  if (others > 0) {
    lines.push(`${INDENT.repeat(2)}${dim(`${others} other file${others === 1 ? '' : 's'} changed too`)}`);
  }
  return lines;
}

/**
 * Where the context filled up and was summarised away.
 *
 * **Stated, not judged**, and absent entirely when it did not happen. There is
 * no threshold and no verb: compacting is the harness working, not a mistake,
 * and the only honest response — run shorter sessions — is advice this project
 * does not give. What it adds is the scale, which is otherwise invisible: one
 * real session dropped 2.8M tokens without ever saying so.
 */
export function renderCompaction(stats: SessionStats): string[] {
  const c = stats.compactions;
  if (c.count === 0) return [];

  // ── The scale, not the audit trail ────────────────────────────────────────
  //
  // This printed a row per compaction — `turn 5  968k → 67k` — plus a tally of
  // the ones whose sizes the older record shape does not carry. True, and a
  // debug view: the reader cannot act on any individual row, and eight of them
  // buried the one fact that matters.
  //
  // Still stated and not judged. Compacting is the harness working, not a
  // mistake, and the only honest response — run shorter sessions — is advice
  // this project does not give. What it adds is the scale, which is otherwise
  // invisible: one real session dropped 2.8M tokens without ever saying so.
  const times = c.count === 1 ? 'once' : `${c.count} times`;
  const scale = c.dropped > 0 ? ` ${dim(`(${human(c.dropped)} tokens)`)}` : '';
  return [`${INDENT.repeat(2)}${dim(`Claude's memory of it was summarised ${times}`)}${scale}`];
}

/**
 * What a model flagged, kept visibly apart from what a rule did.
 *
 * **The separation is the point**, not decoration. CLAUDE.md's rule is that the
 * UI never blurs "flagged by rule" and "flagged by a model at 0.7", and a judge
 * earns that caution: the first real judge response this project ever received
 * invented its evidence, citing turn 4 of a session whose packet began at turn
 * 400. The gate caught it. The next one might be subtler, so the reader is told
 * which kind of claim they are reading.
 *
 * The lag is stated too. A judged finding is as old as the last pass, and
 * silently showing stale findings beside live rule ones would imply a currency
 * they do not have.
 */
/**
 * The first sentence, or a clean truncation when there isn't one.
 *
 * The judge's label stage writes in its own register, at length:
 *
 *     The anchoring phrase is the agent's own claim that commit `591dbb9`
 *     stopped the judge discarding the extraction record, when the code
 *     showed the fields were never populated, so the success claim was false.
 *
 * Useful provenance, poor reading — and "anchoring phrase" is internal
 * vocabulary leaking into user output. Clamping is deliberately a **render**
 * fix: changing the rubric would invalidate the measured 165/232 and require
 * re-scoring the whole labelled set.
 */
export function firstSentence(text: string, max: number): string {
  const t = dejargon(text).trim();
  const stop = t.search(/[.!?](\s|$)/);
  const one = stop > 0 ? t.slice(0, stop + 1) : t;
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Strip the judge's own scaffolding from prose meant for a user.
 *
 * The label stage sometimes opens with `The anchoring phrase is …` — 2 of 19
 * findings on this machine, so a minority pattern rather than a systematic one.
 * "Anchoring phrase" is internal vocabulary, and the phrase it names is now
 * displayed above the sentence anyway, so the preamble is both jargon and
 * redundant.
 *
 * A render-time strip rather than a rubric change, for the same reason as the
 * clamp: the rubric is measured, and editing it invalidates 165/232.
 */
function dejargon(text: string): string {
  const stripped = text.replace(
    /^\s*the (?:anchoring|quoted|anchor) phrase is (?:the )?/i,
    '',
  );
  return stripped === text ? text : stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

export function renderJudged(
  findings: { dimension: string; turns: number[]; why: string; quote?: string }[],
  unjudgedTurns: number,
  eta?: string,
): string[] {
  if (findings.length === 0 && unjudgedTurns <= 0) return [];

  // Kept as a heading only when there is something under it. With nothing to
  // show it was a title followed by `nothing so far`, which is two lines to
  // say none — and CLAUDE.md's rule that a model's claim is never blurred with
  // a rule's only needs stating when a claim is actually present.
  const out: string[] = [`${INDENT}${dim('Findings so far')}`];
  for (const f of findings) {
    // ── The marker moved with the heading, and must not be lost ───────────
    //
    // `FLAGGED BY A MODEL` used to be the section title, so every row under it
    // was marked by position. Grouping rule and model findings under
    // `Findings so far` is better for a reader and silently dropped that —
    // leaving `misread_intent  turn 12` indistinguishable from a rule's
    // deterministic finding.
    //
    // CLAUDE.md: the UI never blurs "flagged by rule" and "flagged by a model
    // at 0.7". The caution is earned — the first judge response this project
    // received invented its evidence, citing turn 4 of a session whose packet
    // began at turn 400. So the marker is per-row now, where it cannot be
    // detached from what it qualifies.
    out.push(
      `${INDENT.repeat(2)}${bold(f.dimension)} ${dim('— flagged by a model')}  ` +
        `${dim(`turn${f.turns.length === 1 ? '' : 's'} ${f.turns.join(', ')}`)}`,
    );
    // The quote first, because it is the evidence — what was actually said at
    // that turn. The model's reasoning is a gloss on it and reads as one.
    if (f.quote !== undefined && f.quote.trim() !== '') {
      for (const l of wrapText(`"${firstSentence(f.quote, 160)}"`, 62)) {
        out.push(`${INDENT.repeat(3)}${yellow(l)}`);
      }
    }
    for (const l of wrapText(firstSentence(f.why, 240), 62)) out.push(`${INDENT.repeat(3)}${dim(l)}`);
  }
  // ── "Since the last pass" when there has never been one ──────────────────
  //
  // `unjudgedTurns` equal to the whole session means `judgedBytes === 0`: this
  // session has **never** been read, which is a different sentence from being
  // behind. The old wording implied a pass had happened and fallen behind by
  // six thousand turns, which reads as a broken tool rather than a new one.
  //
  // The count alone also does not answer the question people actually have,
  // which is whether to wait — so the ETA stays wherever we have it.
  if (findings.length === 0 && unjudgedTurns <= 0) {
    out.push(`${INDENT.repeat(2)}${dim('Nothing flagged.')}`);
  }

  // ── A status, said in as many words as a status deserves ─────────────────
  //
  // This was two sentences explaining what a background pass is. A reader who
  // wants that has the docs; a reader looking at their session wants to know
  // whether anything is still coming.
  if (unjudgedTurns > 0) {
    const wait = eta === undefined ? '' : ` — about ${eta}`;
    out.push(
      `${INDENT.repeat(2)}${dim(
        findings.length === 0
          ? `Nothing flagged yet — background analysis still in progress${wait}`
          : `Background analysis still in progress${wait}`,
      )}`,
    );
  }
  return out;
}

/** Wrap on word boundaries. */
function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const w of text.split(' ')) {
    if (line === '') line = w;
    else if (`${line} ${w}`.length <= width) line = `${line} ${w}`;
    else {
      out.push(line);
      line = w;
    }
  }
  if (line !== '') out.push(line);
  return out;
}

/**
 * The numbers the lead is built from, shared by every surface.
 *
 * Data rather than text, because the terminal wants ANSI and the report wants
 * markup — but if each computed its own totals they would drift, and they did:
 * `standing` said 23 findings while the report said 22, one summing
 * occurrences and the other counting grouped findings.
 */
export type LeadFacts = {
  /** Occurrences, not groups: what a user means by "how many times". */
  ruleCount: number;
  judgedCount: number;
  total: number;
  /** Tokens written and discarded. **Rule tier only** — see `leadSegments`. */
  wasted: number;
  editCount: number;
};

export function leadFacts(
  findings: Finding[],
  judgedCount: number,
  editCount: number,
  events: Event[],
): LeadFacts {
  const ruleCount = findings.reduce((n, f) => n + f.occurrences, 0);
  return {
    ruleCount,
    judgedCount,
    total: ruleCount + judgedCount,
    wasted: findings.reduce(
      (n, f) => n + costFor(events, { dimension: f.dimension, subject: f.subject }).written,
      0,
    ),
    editCount,
  };
}

/**
 * The lead, as plain segments the caller styles.
 *
 * **The price belongs to the rule tier, and the line has to say so.** This read
 * `11,000+ tokens written and discarded · 23 findings`, which invites exactly
 * one reading: that twenty-three findings cost eleven thousand tokens. Nineteen
 * of them were judge findings with no price at all — `costFor` handles
 * `edit_retry` and `redundant_call` and nothing else. Attributing the figure is
 * the same keep-the-tiers-distinct rule as everywhere else, applied to the one
 * line everybody reads.
 */
export function leadSegments(f: LeadFacts): { figure?: string; rest: string } {
  if (f.total === 0) {
    return {
      rest:
        f.editCount === 0
          ? 'nothing to analyse — this session made no edits'
          : `no findings across ${f.editCount} edits`,
    };
  }
  const n = (c: number): string => `${c} finding${c === 1 ? '' : 's'}`;
  const also = f.judgedCount > 0 ? ` · ${f.judgedCount} more flagged by a model` : '';
  if (f.wasted > 0) {
    return { figure: `${approx(f.wasted)} tokens`, rest: ` discarded on ${n(f.ruleCount)}${also}` };
  }
  if (f.ruleCount === 0) return { figure: n(f.judgedCount), rest: ' flagged by a model' };
  return { figure: n(f.total), rest: ` across ${f.editCount} edits` };
}

/**
 * The first line, which is the whole pitch in one sentence.
 *
 * A ladder, not a formula, because `costFor` prices only `edit_retry` and
 * `redundant_call` — and `edit_retry` fires on 33.4% of sessions, so roughly
 * two sessions in three have no priced waste to lead with. Pricing the judge
 * dimensions would mean charging every downstream token to one finding, which
 * overstates badly, so the ladder degrades instead of inventing a number:
 *
 *   1. priced waste    "11,000 tokens written and discarded · 4 findings"
 *   2. findings only   "4 findings across 2,260 edits"
 *   3. nothing         "no findings across 2,260 edits"
 *
 * Rungs 2 and 3 must not read as failures of rung 1.
 */
function leadLine(
  findings: Finding[],
  judgedCount: number,
  d: Denominators,
  events: Event[],
): string {
  const seg = leadSegments(leadFacts(findings, judgedCount, d.editCount, events));
  return seg.figure === undefined ? seg.rest : `${bold(seg.figure)}${seg.rest}`;
}

export function render(input: RenderInput): string {
  const { findings, denominators: d } = input;
  const lines: string[] = [];
  const byUuid = new Map(input.events.map((e) => [e.uuid, e]));

  const judgedCount = input.judged?.findings.length ?? 0;

  // The lead first, then who we are talking about. This was the other way
  // round: a reader's first line was `session 46b591a1 · 4362 events`, an
  // identifier and two counts, with the actual news several lines below.
  // The lead is the headline when something was found. When nothing was, the
  // `Findings so far` section below says so in the place a reader looks for
  // it, and printing `no findings across 2,972 edits` first said it twice —
  // once with a denominator nobody asked for.
  //
  // Only when something else will say it. With the judge disabled there is no
  // `Findings so far` section at all, and suppressing the lead as well left a
  // session reporting neither findings nor their absence — caught by the test
  // that asserts the nothing-found case is always stated somewhere.
  const saidBelow = input.judged !== undefined;
  const nothingFound =
    saidBelow && findings.length === 0 && judgedCount === 0 && d.editCount > 0;
  if (!nothingFound) {
    lines.push('', `${INDENT}${leadLine(findings, judgedCount, d, input.events)}`, '');
  } else {
    lines.push('');
  }

  // ── Who we are talking about, in words they can use ──────────────────────
  //
  // This read `session 46b591a1 · 6136 events · 2937 edits · 3d0h`: an id the
  // reader cannot do anything with, a unit we invented (`events`), and four
  // facts compressed past the point of being read.
  //
  // The id stays available — `--session` takes it, and `:report` lists them —
  // but it is not the first thing a person needs. Duration and edits are,
  // because they are what the reader already knows about their own afternoon.
  // ── Time worked, not time elapsed ────────────────────────────────────────
  //
  // This read `durationOf(first, last)` — wall clock between the first and
  // last event. A session opened at 06:14, left alone, and returned to at
  // 18:35 therefore reported **12h20m** across 59 lines, and the user's
  // reaction was the correct one: *"this session cannot be 12h long! I had
  // just started it."*
  //
  // It was never wrong, only useless: nobody counts the hours a tab sat open
  // as time spent. Gaps longer than `IDLE_GAP_MS` are dropped, so what is
  // reported is time engaged.
  const dur = proseDuration(activeDuration(input.events));
  const edits = `${d.editCount.toLocaleString()} edit${d.editCount === 1 ? '' : 's'}`;
  const where = dur === undefined ? edits : `${dur}, ${edits}`;
  lines.push(`${INDENT}${dim(`This session · ${where}`)}`, '');

  // ── Both tiers, or the "nothing found" line is a lie ────────────────────
  //
  // This branched on `findings.length` alone — the rule tier — while judge
  // findings arrive via `input.judged` and render further down. The result was
  // output that read:
  //
  //     no findings across 2259 edits
  //     FLAGGED BY A MODEL
  //       constraint_violation  turns 3630, 3633, 3771
  //       …three more
  //
  // A reader sees that and concludes the tool is broken, which is worse than
  // either tier being wrong.
  // The nothing-found case is already stated by the lead; this only renders
  // the findings themselves when there are any.
  for (const f of findings) lines.push(...renderFinding(f, byUuid, input.events));

  const stats = sessionStats(input.events);

  // ── Two groups, because they are two kinds of claim ──────────────────────
  //
  // A flat list of sentences was the last attempt, and it failed for the
  // reason headings existed in the first place: `Not read yet`, `compacted 8
  // times` and `revert-churn.ts, 93 versions` are a tool status and two
  // observations, with nothing saying which is which or how to read any of
  // them. Natural is not the same as unstructured.
  //
  // The split is the project's own line, not a layout choice. A **finding**
  // points at turns and claims something went wrong. The rest state facts and
  // claim nothing — `MOST REWRITTEN` exists precisely because `file_churn` was
  // rejected as a dimension, on the grounds that it "reports the same fact
  // without claiming it" (GRAVEYARD.md). Filing these under "Findings" would
  // make the claim the measurement would not support.
  if (input.judged !== undefined) {
    const j = renderJudged(input.judged.findings, input.judged.unjudgedTurns, input.judged.eta);
    if (j.length > 0) lines.push(...j, '');
  }

  const observations = [
    ...renderCost(d, stats, input.baseline),
    ...renderCompaction(stats),
    ...renderRewritten(stats),
  ];
  if (observations.length > 0) {
    lines.push(`${INDENT}${dim('About this session')}`, ...observations, '');
  }

  if (d.unclassifiedTouchCount > 0) {
    // The coverage gap, surfaced rather than folded into a count. An MCP tool
    // carrying a path might write or might read, and we cannot tell.
    lines.push(
      `${INDENT}${d.unclassifiedTouchCount} file-touching call(s) could not be classified as read or write`,
      '',
    );
  }

  if (input.nextStep !== undefined && input.nextStep !== '') {
    lines.push(`${INDENT}${input.nextStep}`, '');
  }

  if (input.muted !== undefined && input.muted.length > 0) {
    // Silence is never mysterious: a muted dimension is named so nobody
    // wonders why it stopped appearing.
    lines.push(`${INDENT}muted: ${input.muted.join(', ')}`, '');
  }

  return lines.join('\n');
}
