/**
 * One pass over the sessions, feeding every section of a report.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * `report` used to take its session list from the catalog, its coverage from
 * `describeCatalog`, and its recommendation from a `Standing` covering all of
 * history. Three sources, so one page could disagree with itself — and it did:
 * the catalog held 4 entries against 8 transcripts on disk, so `report` printed
 *
 *     2026-10-19 → 2026-10-20  no transcripts cover this period
 *
 * for a window that a session it would have listed spanned exactly.
 *
 * So the enumeration happens once, here, and coverage, findings and the
 * standing are all derived from that one list. A section cannot describe
 * sessions another section has not heard of.
 *
 * ── Events are not retained, and the detectors run once ────────────────────
 *
 * Each session's events are parsed, used, and dropped inside one iteration.
 * What survives is the derived view: findings with their evidence already
 * turned into rows, the cost, and the denominators. Holding 40 sessions of
 * events — the design target — to look up six cited turns each would keep the
 * whole history resident for no reason.
 *
 * The standing is folded in the same loop through `accumulateSession`. The
 * first version pushed every session's events into an array and handed them to
 * `computeStanding` afterwards, which kept them all alive *and* re-ran every
 * detector to rediscover findings this loop already had.
 */

import { basename } from 'node:path';
import { parse } from './parsers/index.ts';
import { discoverTranscripts, readSession } from './read.ts';
import { countDenominators, runDetectors, type Denominators, type Detector } from './detect/index.ts';
import { costFor, type Cost } from './cost.ts';
import { caveatFor, evidenceRows, headlineFor, type EvidenceRow } from './render.ts';
import { sessionStats, type SessionStats } from './stats.ts';
import {
  accumulateSession, finishStanding, newStandingAccumulator, type Standing,
} from './standing.ts';
import { recommend, type Recommendation } from './fix.ts';
import type { DateRange } from './report.ts';
import { adviceFor, type Reason } from './detect/labels.ts';
import type { Event, Finding } from './types.ts';
import type { JudgedFinding } from './judge-store.ts';

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
  evidence: EvidenceRow[];
  /** Cited turns beyond the ones in `evidence`. */
  hidden: number;
};

/**
 * A judge finding, flattened for display.
 *
 * Kept in its own list rather than folded into `findings`, because the two
 * tiers are not equally reliable and the display must never imply they are.
 * A rule finding is `certain` — the harness itself refused the call. A judge
 * finding is a model's reading of the conversation. They are counted together
 * in the headline and shown apart.
 */
export type JudgedView = {
  dimension: string;
  turns: number[];
  /** The model's reasoning. Renderers clamp it; it arrives whole. */
  why: string;
  /** The turn text the finding was anchored to, when the judge recorded one. */
  quote?: string;
};

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
  recommendation: Recommendation | undefined;
};

export type GatherOptions = {
  sources: string[];
  detectors: Detector[];
  /**
   * Omit for no date bound at all.
   *
   * Not a very wide range standing in for "everything": the returned
   * `ReportData.range` is what the coverage section segments, and a sentinel
   * like `2000-01-01` put a 26-year *"no transcripts cover this period"* gap at
   * the top of the page. With no bound, the range comes back as the span the
   * sessions actually occupy.
   */
  range?: DateRange;
  preset: string;
  muted: string[];
  /** Narrow to one session. Already resolved — `lookupSession` owns that. */
  onlySessionId?: string;
  /**
   * Judge findings for a session, if the caller has them.
   *
   * Passed in rather than read here, so this module keeps doing no I/O. The
   * archive path lives with the CLI; `findingsFor` in `judge-store.ts` is the
   * implementation every caller should hand over.
   *
   * Omitting it is what every caller did implicitly until now, and the result
   * was a report that could not see 19 of the 22 findings on this machine.
   */
  judgedFor?: (sessionId: string) => JudgedFinding[];
  evidenceMax?: number;
  now?: Date;
};

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

/**
 * The span the sessions actually occupy.
 *
 * **Ends at the last session's last turn, not at `now`.** Running it to the
 * clock makes coverage report the time since as a gap: scoped to one short
 * session from August, the page said *"2026-08-23 → 2026-10-20 (59d) no
 * transcripts cover this period"* about a session it had just analysed.
 */
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

  for (const source of discoverTranscripts(opts.sources)) {
    const sessionId = basename(source, '.jsonl');
    if (opts.onlySessionId !== undefined && sessionId !== opts.onlySessionId) continue;

    let parsed;
    try {
      const read = readSession({ source, sessionId, mode: 'live' });
      parsed = parse(source, read.text, sessionId);
    } catch {
      // Discovered but not readable. Counted so the report cannot quietly
      // analyse fewer sessions than it claims.
      unreadable++;
      continue;
    }
    if (parsed.events.length === 0) continue;

    const events = [...parsed.events].sort((a, b) => a.seq - b.seq);
    const span = spanOf(events);

    // ── Overlap, not containment ─────────────────────────────────────────
    //
    // A session is in range if its span **intersects** the range. Testing
    // whether it *started* inside the range drops a long-running session that
    // began earlier and is still going — which is the same mistake the catalog
    // made: `report` claimed today was uncovered while the session writing
    // today's transcript had simply started eight days ago.
    //
    // Timestamps come from the session's own events, never from a record of
    // when we first saw it.
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

    const byUuid = new Map(events.map((e) => [e.uuid, e]));
    const findings: FindingView[] = res.findings.map((f) => ({
      dimension: f.dimension,
      subject: headlineFor(f, byUuid),
      occurrences: f.occurrences,
      caveat: caveatFor(f),
      reasons: reasonViews(f),
      cost: costFor(events, { dimension: f.dimension, subject: f.subject }),
      evidence: evidenceRows(f, byUuid, max),
      hidden: Math.max(0, f.evidence.length - max),
    }));

    const judged: JudgedView[] = (opts.judgedFor?.(sessionId) ?? []).map((j) => ({
      dimension: j.dimension,
      turns: j.turns,
      why: j.why,
      ...(j.quote !== undefined ? { quote: j.quote } : {}),
    }));

    sessions.push({
      sessionId,
      project,
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

    // While the events are still to hand. Handing them to `computeStanding`
    // afterwards kept every session resident *and* ran every detector a second
    // time to rediscover findings this loop already has.
    accumulateSession(acc, { sessionId, events, findings: res.findings });
  }

  // Findings first, then recency. Strict chronology put three empty sessions
  // above the one with the evidence in it, which is the wrong thing to read
  // first in a report whose whole point is the findings.
  const weight = (s: SessionView): number => s.findings.length + s.judged.length;
  sessions.sort(
    (a, b) => weight(b) - weight(a) || (b.firstTs ?? '').localeCompare(a.firstTs ?? ''),
  );

  // Over the **same** sessions as everything else, so the recommendation cannot
  // describe data the rollup does not show.
  const standing = finishStanding(acc, {
    unreadable,
    ...(opts.now !== undefined ? { now: opts.now.toISOString() } : {}),
  });

  return {
    // With no bound asked for, the range *is* what was found — so the coverage
    // section describes the sessions rather than an invented window around
    // them.
    range: opts.range ?? spanOfSessions(sessions, opts.now ?? new Date()),
    generatedAt: (opts.now ?? new Date()).toISOString(),
    preset: opts.preset,
    muted: opts.muted,
    sessions,
    unreadable,
    standing,
    recommendation: recommend(standing),
  };
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

/**
 * The project a transcript belongs to.
 *
 * The harness encodes the full path as one directory name
 * (`-Users-me-Workspace-agentsensei`), which is unreadable in a report and
 * carries the home directory for no benefit. The trailing segment is the part
 * anybody recognises.
 */
function projectOf(source: string): string {
  const parts = source.split('/');
  const dir = parts[parts.length - 2] ?? 'unknown';
  const tail = dir.split('-').filter(Boolean).pop();
  return tail ?? dir;
}
