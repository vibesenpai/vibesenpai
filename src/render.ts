/**
 * Findings, rendered for a person: evidence turns plus the advice the harness's reason implies.
 * No score or total, no severity words, and an unsourced reason prints as `(reason unknown)`.
 */

import { basename } from 'node:path';
import type { Denominators } from './detect/index.ts';
import type { Event, Finding } from './types.ts';
import { adviceFor, reasonOf, type Reason } from './detect/labels.ts';
import { sessionStats, type Rebuild, type SessionStats } from './stats.ts';
import { approx, costFor } from './cost.ts';
import { alsoText, duration, durationOf, human, shortenPath, wrap } from './format.ts';
import { bold, dim, pad, red, rule, yellow } from './style.ts';
import { establishedLine, SHOW_ESTABLISHED, type Established } from './judge/lookback.ts';

const INDENT = '  ';

/** 68 plus the indent fits in 72, leaving room for the harness gutter in 80 columns. */
const WIDTH = 68;

/** A gap longer than this is idle time, not slow work; generous on purpose. */
const IDLE_GAP_MS = 30 * 60 * 1000;

/** Active time in a session, idle gaps dropped. `undefined` when nothing is measurable. */
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
  // `durationOf` floors to minutes, which would print `0m`.
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

type RenderInput = {
  findings: Finding[];
  denominators: Denominators;
  /** Shown so a reader can tell an empty result from an unanalysed one. */
  sessionId: string;
  /** Model-flagged findings for this session, and how stale they are. */
  judged?: {
    findings: { dimension: string; turns: number[]; why: string }[];
    unjudgedTurns: number;
  };
  /** The session's events, so each cited turn can show what happened there. */
  events: Event[];
  /** Dimensions the user silenced. Named, so silence is never mysterious. */
  muted?: string[];
};

/** First and last timestamps by value, not file order: `/rewind` reorders records. */
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
 * One evidence row, as data. Shared with `src/html.ts`, and lets gather discard the events afterwards.
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
    // Mark the call right after a refusal as the retry.
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

  // Column widths from the rows shown.
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
    out.push(`${INDENT.repeat(2)}${' '.repeat(turnW)}  ${dim(`… ${hidden} more — vibesenpai skeleton`)}`);
  }
  return [...out, ''];
}

/** One evidence row's two columns. The finding's own subject path is not repeated. */
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

/** The qualifier on a finding, or ''. Certain says nothing; anything weaker says so in words. */
const MODEL_METHODS = new Set(['LEX', 'EMB', 'CLS', 'NLI', 'JUDGE']);

export function caveatFor(f: Finding): string {
  if (MODEL_METHODS.has(f.method)) {
    return f.confidence === 'certain' || f.confidence === 'high' ? '' : `${f.confidence} confidence`;
  }
  switch (f.confidence) {
    case 'certain':
      return '';
    case 'high':
      // Only `redundant_call` today, when it compared clipped output.
      return 'close match — compared output was clipped';
    default:
      return `${f.confidence} confidence`;
  }
}

/**
 * A finding's display name. A digest subject from `redundant_call` shows the command instead (display tier only).
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
    // Advice is dimmed so the eye stays on the reason.
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
    // Cost first, under the header: it is the "so what".
    ...costLines(f, events),
    `${INDENT}${yellow(headlineFor(f, byUuid))}`,
    ...adviceLines(f),
    ...evidenceLines(f, byUuid),
  ];
}

/**
 * What this finding cost, in tokens. Written and carried are never summed: carried is cheap cache reads.
 * Absent when nothing could be priced, rather than `0 tokens`.
 */
function costLines(f: Finding, events: Event[]): string[] {
  if (events.length === 0) return [];
  const c = costFor(events, { dimension: f.dimension, subject: f.subject });
  if (c.written + c.received === 0) return [];

  // `[figure, label, note]`; zero rows are dropped.
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

/** How many rebuilds a surface lists before saying how many more there are. */
export const REBUILDS_SHOWN = 3;

/** One rebuild as a fact, shared by terminal, HTML and session start so the wording cannot drift. */
export function rebuildFact(r: Rebuild): { head: string; figure: string; note: string } {
  const after = r.gapMinutes === undefined ? '' : `, ${duration(r.gapMinutes * 60)} after the previous request`;
  return {
    head: `cache rebuilt at turn ${r.seq.toLocaleString('en-US')}${after}`,
    figure: `${r.tokens.toLocaleString('en-US')} cache write`,
    note: `the cache held ${human(r.cached)} before it`,
  };
}

/** Largest first. */
export function largestRebuilds(rs: readonly Rebuild[]): Rebuild[] {
  return [...rs].sort((a, b) => b.tokens - a.tokens);
}

/**
 * Cache rebuilds: the only cache event shown, flagged as abnormal by kind, never by percentile.
 * Stated without advice; the `!` marks it unusual, not severe. Silent when there are none.
 */
export function renderRebuilds(stats: SessionStats): string[] {
  const all = stats.rebuilds.events ?? [];
  if (all.length === 0) return [];

  const ranked = largestRebuilds(all);
  const lines: string[] = [];
  for (const r of ranked.slice(0, REBUILDS_SHOWN)) {
    const f = rebuildFact(r);
    lines.push(`${INDENT.repeat(2)}${bold('!')} ${f.head}`);
    lines.push(`${INDENT.repeat(3)}${bold(f.figure)}  ${dim(f.note)}`);
  }
  const rest = ranked.slice(REBUILDS_SHOWN);
  if (rest.length > 0) {
    const tokens = rest.reduce((n, r) => n + r.tokens, 0);
    lines.push(`${INDENT.repeat(3)}${dim(`and ${rest.length} more, ${human(tokens)} cache write between them`)}`);
  }
  return lines;
}

/**
 * The most-rewritten file, as a ranking with no threshold and no verb.
 * Edit-call count undercounts shell edits; see `src/stats.ts`.
 */
function renderRewritten(stats: SessionStats): string[] {
  const top = stats.rewritten[0];
  if (top === undefined) return [];

  // No threshold: gating it would turn this into the rejected `file_churn` (GRAVEYARD.md).
  const name = basename(top.path);
  const how =
    top.editCalls === 0
      ? ', none from Claude editing it directly'
      : ` across ${top.editCalls} edit${top.editCalls === 1 ? '' : 's'}`;

  const lines = [
    `${INDENT.repeat(2)}${yellow(name)}${dim(` changed most — ${top.versions} versions${how}`)}`,
  ];
  const others = stats.rewritten.length - 1;
  if (others > 0) {
    lines.push(`${INDENT.repeat(2)}${dim(`${others} other file${others === 1 ? '' : 's'} changed too`)}`);
  }
  return lines;
}

/** Compaction, stated and not judged, with the scale it dropped. Absent when it did not happen. */
export function renderCompaction(stats: SessionStats): string[] {
  const c = stats.compactions;
  if (c.count === 0) return [];

  const times = c.count === 1 ? 'once' : `${c.count} times`;
  const scale = c.dropped > 0 ? ` ${dim(`(${human(c.dropped)} tokens)`)}` : '';
  return [`${INDENT.repeat(2)}${dim(`Claude's memory of it was summarised ${times}`)}${scale}`];
}

/**
 * Whole sentences up to `max`, or a hard cut with an ellipsis when the first one is too long.
 * A render fix, not a rubric change, so the measured 165/232 (docs/eval.md) stays valid.
 */
export function firstSentence(text: string, max: number): string {
  const t = dejargon(text).trim();
  if (t.length <= max) return t;

  let out = '';
  for (const part of t.split(/(?<=[.!?])\s+/)) {
    const next = out === '' ? part : `${out} ${part}`;
    if (next.length > max) break;
    out = next;
  }
  // One sentence over budget: hard cut, the only honest ellipsis.
  return out === '' ? `${t.slice(0, max - 1).trimEnd()}…` : out;
}

/** Strip a leading "The anchoring phrase is" from judge prose. Render-time, so the rubric stays measured. */
function dejargon(text: string): string {
  const stripped = text.replace(
    /^\s*the (?:anchoring|quoted|anchor) phrase is (?:the )?/i,
    '',
  );
  return stripped === text ? text : stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

export function renderJudged(
  findings: { dimension: string; secondaryDimensions?: string[]; turns: number[]; why: string; quote?: string; established?: Established }[],
  unjudgedTurns: number,
): string[] {
  if (findings.length === 0 && unjudgedTurns <= 0) return [];

  const out: string[] = [];
  for (const f of findings) {
    out.push(
      `${INDENT.repeat(2)}${bold(f.dimension)}${alsoText(f.secondaryDimensions)}  ` +
        `${dim(`turn${f.turns.length === 1 ? '' : 's'} ${f.turns.join(', ')}`)}`,
    );
    // Quote first: it is the evidence; the reasoning is a gloss.
    if (f.quote !== undefined && f.quote.trim() !== '') {
      for (const l of wrap(`"${firstSentence(f.quote, 160)}"`, 62)) {
        out.push(`${INDENT.repeat(3)}${yellow(l)}`);
      }
    }
    if (SHOW_ESTABLISHED && f.established !== undefined) {
      for (const l of wrap(`Established: ${firstSentence(establishedLine(f.established), 160)}`, 62)) out.push(`${INDENT.repeat(3)}${l}`);
    }
    for (const l of wrap(firstSentence(f.why, 240), 62)) out.push(`${INDENT.repeat(3)}${dim(l)}`);
  }

  if (unjudgedTurns > 0) {
    // Only this session's status; the queue belongs to the Analysis block.
    if (findings.length === 0) {
      out.push(`${INDENT.repeat(2)}${dim('Nothing flagged in this session yet.')}`);
    }
  }
  return out;
}

/** The numbers the lead is built from, shared so every surface counts the same way. */
export type LeadFacts = {
  /** Occurrences, not groups: what a user means by "how many times". */
  ruleCount: number;
  judgedCount: number;
  total: number;
  /** Tokens written and discarded. **Rule tier only** — see `leadSegments`. */
  wasted: number;
  editCount: number;
};

function leadFacts(
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
 * The lead, as segments the caller styles. The token figure is rule-tier only, and the line says so.
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
  const also = f.judgedCount > 0 ? ` · ${f.judgedCount} more flagged` : '';
  if (f.wasted > 0) {
    return { figure: `${approx(f.wasted)} tokens`, rest: ` discarded on ${n(f.ruleCount)}${also}` };
  }
  if (f.ruleCount === 0) return { figure: n(f.judgedCount), rest: ' flagged' };
  return { figure: n(f.total), rest: ` across ${f.editCount} edits` };
}

/**
 * The first line: priced waste, else a finding count, else "no findings". `costFor` prices only
 * `edit_retry` and `redundant_call`, so the ladder degrades rather than inventing a number.
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

  // Skip the lead when nothing was found and something else says so: the judge
  // block, or `0 edits`. With the judge off, the lead is the only "found nothing".
  const saidBelow = input.judged !== undefined || d.editCount === 0;
  const nothingFound = saidBelow && findings.length === 0 && judgedCount === 0;
  if (!nothingFound) {
    lines.push('', `${INDENT}${leadLine(findings, judgedCount, d, input.events)}`, '');
  } else {
    lines.push('');
  }

  // Active time (idle gaps dropped) and edits, not the session id.
  const dur = proseDuration(activeDuration(input.events));
  const edits = `${d.editCount.toLocaleString()} edit${d.editCount === 1 ? '' : 's'}`;
  const where = dur === undefined ? edits : `${dur}, ${edits}`;
  lines.push(`${INDENT}${dim(`This session · ${where}`)}`, '');

  for (const f of findings) lines.push(...renderFinding(f, byUuid, input.events));

  const stats = sessionStats(input.events);

  // Findings, then observations, which state facts and claim nothing.
  if (input.judged !== undefined) {
    const j = renderJudged(input.judged.findings, input.judged.unjudgedTurns);
    if (j.length > 0) lines.push(...j, '');
  }

  const observations = [
    ...renderCompaction(stats),
    ...renderRebuilds(stats),
    ...renderRewritten(stats),
  ];
  if (observations.length > 0) {
    lines.push(...observations, '');
  }

  if (d.unclassifiedTouchCount > 0) {
    // An MCP tool with a path might read or write; we cannot tell.
    lines.push(
      `${INDENT}${d.unclassifiedTouchCount} file-touching call(s) could not be classified as read or write`,
      '',
    );
  }

  if (input.muted !== undefined && input.muted.length > 0) {
    // Named, so silence is never mysterious.
    lines.push(`${INDENT}muted: ${input.muted.join(', ')}`, '');
  }

  return lines.join('\n');
}
