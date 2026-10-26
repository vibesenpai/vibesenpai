/**
 * One pass over the sessions feeding every report section, so no section can describe sessions
 * another has not seen. Each session's events are dropped after its iteration.
 */

import { basename } from 'node:path';
import { parse } from './parsers/index.ts';
import { discoverTranscripts, projectLabel, projectOf, readSession } from './read.ts';
import { countDenominators, runDetectors, type Denominators, type Detector } from './detect/index.ts';
import { costFor, type Cost } from './cost.ts';
import { caveatFor, evidenceRows, headlineFor, type EvidenceRow } from './render.ts';
import { sessionStats, type SessionStats } from './stats.ts';
import { cleanCut, isHarnessNoise } from './judge/packet.ts';
import { redact } from './redact.ts';
import {
  accumulateSession, finishStanding, newStandingAccumulator, type Standing,
} from './standing.ts';
import { compactionsFor, recommend, type Compactions, type Recommendation } from './fix.ts';
import type { DateRange } from './range.ts';
import { adviceFor, type Reason } from './detect/labels.ts';
import type { Event, Finding } from './types.ts';
import type { JudgedFinding } from './judge/state.ts';
import { emptyDismissed, withoutDismissed, type Dismissed } from './dismiss.ts';

/** A finding, flattened to what a renderer needs and nothing more. */
export type FindingView = {
  dimension: string;
  /** As `headlineFor` names it — a path, or a command for a digest subject. */
  subject: string;
  occurrences: number;
  /** Empty when the finding is a certain rule; see `caveatFor`. */
  caveat: string;
  reasons: { reason: string; count: number; advice: string }[];
  cost: Cost;
  evidence: AskedRow[];
  /** Cited turns beyond the ones in `evidence`. */
  hidden: number;
};

/** A judge finding for display. Kept apart from rule findings: the tiers are not equally reliable. */
export type JudgedView = {
  dimension: string;
  turns: number[];
  /** The model's reasoning. Renderers clamp it; it arrives whole. */
  why: string;
  /** The turn text the finding was anchored to, when the judge recorded one. */
  quote?: string;
  /** What the person asked before the first cited turn. */
  asked?: Asked;
};

/** The prompt a cited turn answered: redacted `textSummary`, cut so it still survives `redact`. */
export type Asked = { seq: number; ts?: string; text: string };

export type AskedRow = EvidenceRow & { asked?: Asked };

export type SessionView = {
  sessionId: string;
  project: string;
  firstTs?: string;
  lastTs?: string;
  findings: FindingView[];
  /** The opt-in model tier. Empty when the judge is off or has not run. */
  judged: JudgedView[];
  denominators: Denominators;
  stats: SessionStats;
  cost: Cost;
};

export type ReportData = {
  range: DateRange;
  generatedAt: string;
  preset: string;
  muted: string[];
  sessions: SessionView[];
  /** Discovered but unparseable. Counted, never silently dropped. */
  unreadable: number;
  standing: Standing;
  /** One recommendation per dimension found, from the same `recommend` that `fix` uses. */
  recommendations: Record<string, Recommendation>;
};

type GatherOptions = {
  sources: string[];
  detectors: Detector[];
  /** Omit for no bound: the range then becomes the span the sessions occupy, not a sentinel. */
  range?: DateRange;
  preset: string;
  muted: string[];
  /** Narrow to one session. Already resolved — `lookupSession` owns that. */
  onlySessionId?: string;
  /** Judge findings for a session (see `findingsFor` in `judge/state.ts`). Passed in: no I/O here. */
  judgedFor?: (sessionId: string) => JudgedFinding[];
  /** What the person dismissed. Judge findings arrive already filtered. */
  dismissed?: Dismissed;
  evidenceMax?: number;
  now?: Date;
};

/** Long enough to recognise a request, short enough to sit on one line. */
const ASKED_MAX = 160;

/** Every prompt the person typed, in order. Excludes sidechain prompts and harness noise. */
export function promptsOf(events: Event[]): Asked[] {
  const out: Asked[] = [];
  for (const e of events) {
    if (e.turnType !== 'user_prompt' || e.isSidechain) continue;
    let text = (e.textSummary ?? '').trim();
    if (text === '' || isHarnessNoise(text)) continue;
    if (text.length > ASKED_MAX) text = `${cleanCut(text.slice(0, ASKED_MAX)).trimEnd()}…`;
    else if (redact(text).text !== text) text = cleanCut(text);
    if (text === '' || text === '…') continue;
    out.push({ seq: e.seq, ...(e.ts !== undefined ? { ts: e.ts } : {}), text });
  }
  return out;
}

/** The last prompt at or before `seq`. `prompts` is in seq order. */
export function askedBefore(prompts: Asked[], seq: number): Asked | undefined {
  let lo = 0;
  let hi = prompts.length - 1;
  let hit: Asked | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = prompts[mid] as Asked;
    if (p.seq <= seq) {
      hit = p;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return hit;
}

/** First and last plausible timestamps, which is this session's own span. */
function spanOf(events: Event[]): { firstTs?: string; lastTs?: string } {
  let first: string | undefined;
  let last: string | undefined;
  for (const e of events) {
    if (e.ts === undefined) continue;
    if (first === undefined || e.ts < first) first = e.ts;
    if (last === undefined || e.ts > last) last = e.ts;
  }
  return {
    ...(first !== undefined ? { firstTs: first } : {}),
    ...(last !== undefined ? { lastTs: last } : {}),
  };
}

/** The span the sessions occupy. Ends at the last turn, not `now`, so idle time is not a gap. */
function spanOfSessions(sessions: SessionView[], now: Date): DateRange {
  const starts = sessions.map((s) => s.firstTs).filter((t): t is string => t !== undefined);
  const ends = sessions.map((s) => s.lastTs).filter((t): t is string => t !== undefined);
  if (starts.length === 0) return { from: now, to: now };
  return {
    from: new Date(starts.reduce((a, b) => (a < b ? a : b))),
    to: ends.length > 0 ? new Date(ends.reduce((a, b) => (a > b ? a : b))) : now,
  };
}

export async function gatherReport(opts: GatherOptions): Promise<ReportData> {
  const max = opts.evidenceMax ?? 6;
  const sessions: SessionView[] = [];
  // Folded in per session, so no session's events outlive its iteration.
  const acc = newStandingAccumulator();
  let unreadable = 0;
  const allJudged: JudgedFinding[] = [];
  const compactions: Compactions = new Map();

  for (const source of discoverTranscripts(opts.sources)) {
    const sessionId = basename(source, '.jsonl');
    if (opts.onlySessionId !== undefined && sessionId !== opts.onlySessionId) continue;

    let parsed;
    try {
      const read = readSession({ source, sessionId, mode: 'live' });
      parsed = parse(source, read.text, sessionId);
    } catch {
      // Counted so the report cannot quietly analyse fewer sessions than it claims.
      unreadable++;
      continue;
    }
    if (parsed.events.length === 0) continue;

    const events = [...parsed.events].sort((a, b) => a.seq - b.seq);
    const span = spanOf(events);

    // In range if the session's own span intersects it, so a long-running session is not dropped.
    if (opts.range !== undefined && span.firstTs !== undefined && span.lastTs !== undefined) {
      const from = Date.parse(span.firstTs);
      const to = Date.parse(span.lastTs);
      if (
        Number.isFinite(from) &&
        Number.isFinite(to) &&
        (to < opts.range.from.getTime() || from > opts.range.to.getTime())
      ) {
        continue;
      }
    }

    const project = projectOf(source);
    const res = await runDetectors({
      events,
      session: { sessionId, project, live: false },
      detectors: opts.detectors,
    });
    const shown = withoutDismissed(res.findings, opts.dismissed ?? emptyDismissed()).findings;

    const byUuid = new Map(events.map((e) => [e.uuid, e]));
    const prompts = promptsOf(events);
    const withAsked = (r: EvidenceRow): AskedRow => {
      const seq = Number(r.turn);
      const asked = Number.isFinite(seq) ? askedBefore(prompts, seq) : undefined;
      return asked === undefined ? r : { ...r, asked };
    };
    const findings: FindingView[] = shown.map((f) => ({
      dimension: f.dimension,
      subject: headlineFor(f, byUuid),
      occurrences: f.occurrences,
      caveat: caveatFor(f),
      reasons: reasonViews(f),
      cost: costFor(events, { dimension: f.dimension, subject: f.subject }),
      evidence: evidenceRows(f, byUuid, max).map(withAsked),
      hidden: Math.max(0, f.evidence.length - max),
    }));

    const judgedRaw = opts.judgedFor?.(sessionId) ?? [];
    allJudged.push(...judgedRaw);
    // Same compaction check `fix` makes before a judged turn.
    for (const [id, c] of compactionsFor(judgedRaw, () => events)) compactions.set(id, c);
    const judged: JudgedView[] = judgedRaw.map((j) => {
      const first = j.turns.length > 0 ? Math.min(...j.turns) : undefined;
      const asked = first === undefined ? undefined : askedBefore(prompts, first);
      return {
        dimension: j.dimension,
        turns: j.turns,
        why: j.why,
        ...(j.quote !== undefined ? { quote: j.quote } : {}),
        ...(asked !== undefined ? { asked } : {}),
      };
    });

    sessions.push({
      sessionId,
      project: projectLabel(project),
      ...span,
      findings,
      judged,
      denominators: countDenominators(events),
      stats: sessionStats(events),
      cost: findings.reduce(
        (a, f) => ({
          written: a.written + f.cost.written,
          received: a.received + f.cost.received,
          carriedTurns: Math.max(a.carriedTurns, f.cost.carriedTurns),
          carried: a.carried + f.cost.carried,
        }),
        { written: 0, received: 0, carriedTurns: 0, carried: 0 },
      ),
    });

    // Folded here so events are not kept and detectors are not re-run.
    accumulateSession(acc, { sessionId, events, findings: shown });
  }

  // Sessions with findings first, then most recent.
  const weight = (s: SessionView): number => s.findings.length + s.judged.length;
  sessions.sort(
    (a, b) => weight(b) - weight(a) || (b.firstTs ?? '').localeCompare(a.firstTs ?? ''),
  );

  // Over the same sessions as everything else.
  const standing = finishStanding(acc, {
    unreadable,
    ...(opts.now !== undefined ? { now: opts.now.toISOString() } : {}),
  });

  return {
    range: opts.range ?? spanOfSessions(sessions, opts.now ?? new Date()),
    generatedAt: (opts.now ?? new Date()).toISOString(),
    preset: opts.preset,
    muted: opts.muted,
    sessions,
    unreadable,
    standing,
    recommendations: recommendationsFor(standing, sessions, allJudged, compactions),
  };
}

/** One recommendation per dimension, each computed over that dimension's own findings and reasons. */
function recommendationsFor(
  standing: Standing,
  sessions: SessionView[],
  judged: JudgedFinding[],
  compactions: Compactions,
): Record<string, Recommendation> {
  const out: Record<string, Recommendation> = {};
  for (const dim of standing.dimensions) {
    const reasons: Record<string, number> = {};
    for (const s of sessions) {
      for (const f of s.findings) {
        if (f.dimension !== dim.dimension) continue;
        for (const r of f.reasons) reasons[r.reason] = (reasons[r.reason] ?? 0) + r.count;
      }
    }
    const r = recommend({ ...standing, dimensions: [dim], reasons });
    if (r !== undefined) out[dim.dimension] = r;
  }
  for (const dim of new Set(judged.map((j) => j.dimension))) {
    const r = recommend(undefined, judged.filter((j) => j.dimension === dim), compactions);
    if (r !== undefined) out[dim] = r;
  }
  return out;
}

/** Reasons with their advice, ordered by how often each occurred. */
function reasonViews(f: Finding): { reason: string; count: number; advice: string }[] {
  return Object.entries(f.reasons ?? {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, count]) => ({ reason, count, advice: adviceOf(reason) }));
}

/** Wrapped so `src/detect/labels.ts` stays the one place a reason becomes words. */
function adviceOf(reason: string): string {
  return adviceFor(reason as Reason) ?? '';
}

