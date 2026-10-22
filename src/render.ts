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

import type { Denominators } from './detect/index.ts';
import type { Event, Finding } from './types.ts';
import { adviceFor, reasonOf, type Reason } from './detect/labels.ts';
import { sessionStats, type SessionStats } from './stats.ts';
import { approx, costFor } from './cost.ts';
import { bold, dim, pad, red, rule, yellow } from './style.ts';

/** Corpus percentiles, so a session's number has something to sit against. */
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

export type RenderInput = {
  findings: Finding[];
  denominators: Denominators;
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
 * What the session cost, stated and not judged.
 *
 * Totals only. The *anchored* half — which turns the re-ingestion came from —
 * needs per-turn accounting and arrives with `context_reingest`; printing a
 * placeholder for it would be worse than leaving it out.
 *
 * `cacheRead` is deliberately absent. It re-counts the whole prefix on every
 * call, so it grows with the square of the turn count and any ratio built on it
 * is pinned near 1 by construction. Showing it would invite exactly the
 * reasoning that GRAVEYARD.md records as the fifth instance of that mistake.
 */
export function renderCost(d: Denominators, stats?: SessionStats): string[] {
  const { output, cacheCreation } = d.tokens;
  if (output === 0 && cacheCreation === 0) return [];

  const parts = [
    `${bold(human(output))} ${dim('out')}`,
    `${bold(human(cacheCreation))} ${dim('re-ingested')}`,
  ];
  if (output > 0) {
    const ratio = cacheCreation / output;
    const where =
      ratio >= CORPUS.reingestP90
        ? `at or above the corpus 90th percentile of ${CORPUS.reingestP90.toFixed(1)}`
        : `corpus median ${CORPUS.reingestP50.toFixed(1)}`;
    parts.push(`${dim('ratio')} ${bold(ratio.toFixed(1))} ${dim(`(${where})`)}`);
  }
  const out = [
    `${INDENT}${dim('SESSION COST')}`,
    `${INDENT.repeat(2)}${parts.join(dim(' · '))}`,
  ];

  // The anchored half. Measured: half a session's re-ingestion comes from 6% of
  // its turns, so naming the heaviest few is a ranking rather than a threshold.
  const heaviest = stats?.reingest.heaviest ?? [];
  if (heaviest.length > 1 && stats !== undefined && stats.reingest.share > 0) {
    const turns = heaviest.map((t) => t.seq).join(', ');
    out.push(
      `${INDENT.repeat(2)}${dim('heaviest at turns')} ${bold(turns)} ${dim('—')} ` +
        `${bold(`${Math.round(stats.reingest.share * 100)}%`)} ${dim('of it')}`,
    );
  }
  return out;
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
export function renderRewritten(stats: SessionStats, max = 4): string[] {
  const shown = stats.rewritten.slice(0, max);
  if (shown.length === 0) return [];
  const width = Math.max(...shown.map((f) => String(f.versions).length));
  const lines = [`${INDENT}${dim('MOST REWRITTEN')}`];
  for (const f of shown) {
    const via =
      f.editCalls === 0 ? 'no edit-tool calls' : `${f.editCalls} edit call${f.editCalls === 1 ? '' : 's'}`;
    lines.push(
      `${INDENT.repeat(2)}${pad(String(f.versions), width, bold, 'right')} ${dim('versions')}  ` +
        `${pad(shortenPath(f.path, 42), 42, yellow)} ${dim(via)}`,
    );
  }
  const hidden = stats.rewritten.length - shown.length;
  if (hidden > 0) lines.push(`${INDENT.repeat(2)}${dim(`… ${hidden} more`)}`);
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

  const times = c.count === 1 ? 'once' : `${c.count}×`;
  const head =
    c.dropped > 0
      ? `compacted ${times} ${dim('— dropped')} ${bold(human(c.dropped))} ${dim('tokens of context')}`
      : `compacted ${times}`;
  const out = [`${INDENT}${dim('CONTEXT')}`, `${INDENT.repeat(2)}${head}`];

  const w = Math.max(...c.measured.map((m) => String(m.seq).length), 1);
  for (const m of c.measured) {
    out.push(
      `${INDENT.repeat(2)}  ${dim('turn')} ${pad(String(m.seq), w, bold, 'right')}   ` +
        `${bold(human(m.preTokens))} ${dim('→')} ${human(m.postTokens)}`,
    );
  }
  // Said rather than hidden: the older record shape carries no figures, so a
  // count without numbers is a real state and not a bug.
  if (c.measured.length < c.count) {
    out.push(`${INDENT.repeat(2)}  ${dim(`${c.count - c.measured.length} without reported sizes`)}`);
  }
  return out;
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
export function renderJudged(
  findings: { dimension: string; turns: number[]; why: string }[],
  unjudgedTurns: number,
  eta?: string,
): string[] {
  if (findings.length === 0 && unjudgedTurns <= 0) return [];

  const out: string[] = [`${INDENT}${dim('FLAGGED BY A MODEL')}`];
  for (const f of findings) {
    out.push(
      `${INDENT.repeat(2)}${bold(f.dimension)}  ${dim(`turn${f.turns.length === 1 ? '' : 's'} ${f.turns.join(', ')}`)}`,
    );
    for (const l of wrapText(f.why, 62)) out.push(`${INDENT.repeat(3)}${dim(l)}`);
  }
  if (findings.length === 0) out.push(`${INDENT.repeat(2)}${dim('nothing so far')}`);
  if (unjudgedTurns > 0) {
    // The count alone does not answer the question people actually have,
    // which is whether to wait. The ETA is what turns this from a status into
    // something you can act on.
    out.push(
      `${INDENT.repeat(2)}${dim(
        eta === undefined
          ? `… ${unjudgedTurns} turns since the last pass`
          : `… ${unjudgedTurns} turns since the last pass · about ${eta} to read them`,
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

export function render(input: RenderInput): string {
  const { findings, denominators: d } = input;
  const lines: string[] = [];
  const byUuid = new Map(input.events.map((e) => [e.uuid, e]));

  const facts = [`${input.events.length} events`, `${d.editCount} edits`];
  const span = spanOf(input.events);
  const dur = durationOf(span.first, span.last);
  if (dur !== undefined) facts.push(dur);
  lines.push('', `${INDENT}session ${input.sessionId.slice(0, 8)} · ${facts.join(' · ')}`, '');

  if (findings.length === 0) {
    // Said plainly. A blank result must not read as "we did not look", and the
    // denominator is what makes the difference legible: nothing found across
    // 155 edits is a real statement; nothing found across 0 is not.
    lines.push(
      d.editCount === 0
        ? `${INDENT}nothing to analyse — this session made no edits`
        : `${INDENT}no findings across ${d.editCount} edits`,
      '',
    );
  } else {
    for (const f of findings) lines.push(...renderFinding(f, byUuid, input.events));
  }

  const stats = sessionStats(input.events);
  const cost = renderCost(d, stats);
  if (cost.length > 0) lines.push(...cost, '');

  if (input.judged !== undefined) {
    const j = renderJudged(input.judged.findings, input.judged.unjudgedTurns, input.judged.eta);
    if (j.length > 0) lines.push(...j, '');
  }

  const compaction = renderCompaction(stats);
  if (compaction.length > 0) lines.push(...compaction, '');

  const rewritten = renderRewritten(stats);
  if (rewritten.length > 0) lines.push(...rewritten, '');

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
