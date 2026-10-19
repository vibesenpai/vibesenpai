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

/** Corpus percentiles, so a session's number has something to sit against. */
export const CORPUS = {
  /**
   * `cacheCreation / output` per session, measured over 1,139 SWE-chat
   * sessions. Quoted rather than used as a threshold: this module states where
   * a session sits, it does not judge it.
   */
  reingestP50: 12.0,
  reingestP90: 93.4,
} as const;

const INDENT = '  ';

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
function evidenceLines(f: Finding, byUuid: Map<string, Event>, max = 6): string[] {
  const out: string[] = [];
  const shown = f.evidence.slice(0, max);
  for (const ref of shown) {
    const seq = ref.seq === undefined ? '    ?' : String(ref.seq).padStart(5);
    const e = byUuid.get(ref.uuid);
    const what = e === undefined ? '' : `  ${describeTurn(e)}`;
    out.push(`${INDENT.repeat(3)}turn ${seq}${what}`);
  }
  const hidden = f.evidence.length - shown.length;
  if (hidden > 0) {
    out.push(`${INDENT.repeat(3)}      … ${hidden} more turn(s) — see \`agentsensei skeleton\``);
  }
  return out;
}

/** The reason tally as advice lines, widest reason name first for alignment. */
function adviceLines(f: Finding): string[] {
  const reasons = Object.entries(f.reasons ?? {});
  if (reasons.length === 0) return [`${INDENT.repeat(2)}(reason unknown)`];
  const width = Math.max(...reasons.map(([k]) => k.length));
  return reasons
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => {
      const advice = adviceFor(reason as Reason) ?? '';
      const count = n > 1 ? ` ×${n}` : '';
      return `${INDENT.repeat(2)}${reason.padEnd(width)}${count}  ${advice}`;
    });
}

/**
 * A readable headline for a finding whose subject is a digest.
 *
 * A detector cannot read a command, so `redundant_call` names a Bash run
 * `Bash #8e0f94` — correct as identity and useless as a headline. The renderer
 * *may* read it, so it substitutes the command from the first cited turn while
 * keeping the digest, which is what the finding is actually keyed on.
 */
export function headlineFor(f: Finding, byUuid: Map<string, Event>): string {
  const digest = /#[0-9a-f]{4,}$/.exec(f.subject);
  if (digest === null) return shortenPath(f.subject);
  const first = f.evidence.map((r) => byUuid.get(r.uuid)).find((e) => e?.command !== undefined);
  if (first?.command === undefined) return f.subject;
  return `${shortenPath(first.command.replace(/\s+/g, ' '), 56)}  ${digest[0]}`;
}

export function renderFinding(f: Finding, byUuid: Map<string, Event> = new Map()): string[] {
  const times = f.occurrences > 1 ? ` ×${f.occurrences}` : '';
  return [
    `${INDENT}⚑ ${f.dimension}${times}   [${f.confidence}]`,
    `${INDENT.repeat(2)}${headlineFor(f, byUuid)}`,
    ...adviceLines(f),
    ...evidenceLines(f, byUuid),
  ];
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

  const parts = [`${human(output)} out`, `${human(cacheCreation)} re-ingested`];
  if (output > 0) {
    const ratio = cacheCreation / output;
    const where =
      ratio >= CORPUS.reingestP90
        ? `at or above the corpus 90th percentile of ${CORPUS.reingestP90.toFixed(1)}`
        : `corpus median ${CORPUS.reingestP50.toFixed(1)}`;
    parts.push(`ratio ${ratio.toFixed(1)} (${where})`);
  }
  const out = [`${INDENT}SESSION COST`, `${INDENT.repeat(2)}${parts.join(' · ')}`];

  // The anchored half. Measured: half a session's re-ingestion comes from 6% of
  // its turns, so naming the heaviest few is a ranking rather than a threshold.
  const heaviest = stats?.reingest.heaviest ?? [];
  if (heaviest.length > 1 && stats !== undefined && stats.reingest.share > 0) {
    const turns = heaviest.map((t) => t.seq).join(', ');
    out.push(
      `${INDENT.repeat(2)}heaviest at turns ${turns} — ${Math.round(stats.reingest.share * 100)}% of it`,
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
  const lines = [`${INDENT}MOST REWRITTEN`];
  for (const f of shown) {
    const via =
      f.editCalls === 0 ? 'no edit-tool calls' : `${f.editCalls} edit call${f.editCalls === 1 ? '' : 's'}`;
    lines.push(
      `${INDENT.repeat(2)}${String(f.versions).padStart(width)} versions  ` +
        `${shortenPath(f.path, 42).padEnd(42)} ${via}`,
    );
  }
  const hidden = stats.rewritten.length - shown.length;
  if (hidden > 0) lines.push(`${INDENT.repeat(2)}… ${hidden} more`);
  return lines;
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
    for (const f of findings) lines.push(...renderFinding(f, byUuid), '');
  }

  const stats = sessionStats(input.events);
  const cost = renderCost(d, stats);
  if (cost.length > 0) lines.push(...cost, '');

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

  if (input.muted !== undefined && input.muted.length > 0) {
    // Silence is never mysterious: a muted dimension is named so nobody
    // wonders why it stopped appearing.
    lines.push(`${INDENT}muted: ${input.muted.join(', ')}`, '');
  }

  return lines.join('\n');
}
