/**
 * Date ranges for the retrospective surface, and the depth each range can
 * honestly be answered at.
 *
 * ── Why depth is a first-class output ────────────────────────────────────────
 *
 * We keep no transcript copies, so history is bounded by the harness's TTL. A
 * range reaching back before the first scan cannot be answered with tool calls
 * and outcomes — only with prompts, from `history.jsonl`, which survives
 * cleanup.
 *
 * The tempting behaviour is to return what we have and say nothing. That is the
 * one thing we must not do: a report covering September that silently analysed
 * only the last six days reads as "you improved", when the truth is "we cannot
 * see September". So every range is split into the part we can answer fully and
 * the part we can only answer shallowly, and both are labelled.
 *
 * This module is pure — no clock, no filesystem. The current time and the
 * catalogue's coverage arrive as parameters, so labelling is testable without
 * mocking time.
 */

export type Depth =
  /** Tool calls, outcomes, every detector. Within the catalog's coverage. */
  | 'full'
  /** Prompts only, from `history.jsonl`. Before the first scan. */
  | 'prompt-level'
  /** Nothing survives for this period. Reported, never silently empty. */
  | 'none'
  /**
   * We have not looked yet. Distinct from `none` on purpose: telling someone
   * their transcripts were deleted when in fact no scan has run is a false
   * cause, and it sends them looking for data loss that never happened.
   */
  | 'unscanned';

export type DateRange = { from: Date; to: Date };

export type RangeSegment = DateRange & { depth: Depth };

/**
 * Parse `--last 7d` / `30d` / `12w` / `6m`.
 *
 * Returns undefined rather than throwing on a malformed value, so the caller
 * decides whether that is a usage error or a fallback.
 */
export function parseLast(spec: string, now: Date): DateRange | undefined {
  const m = /^(\d+)([dwm])$/.exec(spec.trim());
  if (m === null) return undefined;
  const n = Number(m[1]);
  if (n <= 0) return undefined;
  const days = m[2] === 'd' ? n : m[2] === 'w' ? n * 7 : n * 30;
  const from = new Date(now.getTime() - days * 86_400_000);
  return { from, to: now };
}

/** Parse `YYYY-MM-DD`, rejecting a date that does not exist (e.g. 2026-02-31). */
export function parseDate(spec: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(spec.trim());
  if (m === null) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  // Round-trip check: `Date.UTC` happily rolls 02-31 over into March.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return undefined;
  }
  return dt;
}

export type RangeInput = {
  last?: string;
  since?: string;
  until?: string;
};

export type RangeResult =
  | { ok: true; range: DateRange }
  | { ok: false; error: string };

/**
 * Resolve the range flags into one window.
 *
 * `--last` is mutually exclusive with `--since`/`--until`: accepting both would
 * force a precedence rule that nobody could guess from the output.
 */
export function resolveRange(input: RangeInput, now: Date): RangeResult {
  const hasExplicit = input.since !== undefined || input.until !== undefined;

  if (input.last !== undefined && hasExplicit) {
    return { ok: false, error: '--last cannot be combined with --since or --until' };
  }

  if (input.last !== undefined) {
    const r = parseLast(input.last, now);
    return r === undefined
      ? { ok: false, error: `--last expects a value like 7d, 4w or 6m (got "${input.last}")` }
      : { ok: true, range: r };
  }

  if (!hasExplicit) {
    // A default is better than a required flag here: the common case is "recent".
    return { ok: true, range: parseLast('7d', now) as DateRange };
  }

  const from = input.since === undefined ? undefined : parseDate(input.since);
  if (input.since !== undefined && from === undefined) {
    return { ok: false, error: `--since expects YYYY-MM-DD (got "${input.since}")` };
  }
  const to = input.until === undefined ? undefined : parseDate(input.until);
  if (input.until !== undefined && to === undefined) {
    return { ok: false, error: `--until expects YYYY-MM-DD (got "${input.until}")` };
  }

  const range = {
    from: from ?? new Date(0),
    to: to ?? now,
  };
  if (range.from.getTime() > range.to.getTime()) {
    return { ok: false, error: '--since is after --until' };
  }
  return { ok: true, range };
}

export type CoverageInput = {
  /**
   * The periods catalogued transcripts actually cover — one interval per
   * session, in any order, overlaps allowed.
   *
   * A single "data starts here" boundary was tried first and is wrong: on real
   * data this machine has one session on 23 August and three from 12 October,
   * with **nothing in September**. A boundary at the earliest record would
   * report 49 days of full depth over a month that holds no sessions at all —
   * the same false claim the depth labelling exists to prevent, just inverted.
   */
  covered: DateRange[];
  /** True once at least one session is catalogued. */
  scanned: boolean;
  /** True when prompt history exists for the shallow tier. */
  hasPromptHistory: boolean;
};

/** Sort, then merge touching or overlapping intervals. */
function mergeRanges(ranges: DateRange[]): DateRange[] {
  const sorted = [...ranges]
    .filter((r) => r.to.getTime() >= r.from.getTime())
    .sort((a, b) => a.from.getTime() - b.from.getTime());

  const out: DateRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && r.from.getTime() <= last.to.getTime()) {
      if (r.to.getTime() > last.to.getTime()) last.to = r.to;
      continue;
    }
    out.push({ from: r.from, to: r.to });
  }
  return out;
}

/**
 * Split a range into the parts we can answer fully and the parts we cannot.
 *
 * Gaps between sessions are reported, not glossed. Segments come back in
 * chronological order and never overlap. An empty array is impossible — a range
 * always gets at least one segment, because "we have nothing for this period" is
 * an answer and silence is not.
 */
export function segmentByDepth(range: DateRange, cov: CoverageInput): RangeSegment[] {
  // The shallow floor differs by *why* we have nothing: never looked, versus
  // looked and the transcripts are gone.
  const shallow: Depth = cov.hasPromptHistory
    ? 'prompt-level'
    : cov.scanned
      ? 'none'
      : 'unscanned';

  const lo = range.from.getTime();
  const hi = range.to.getTime();

  // Clip each covered interval to the requested range, then merge.
  const clipped = mergeRanges(
    cov.covered
      .map((c) => ({
        from: new Date(Math.max(c.from.getTime(), lo)),
        to: new Date(Math.min(c.to.getTime(), hi)),
      }))
      .filter((c) => c.to.getTime() > c.from.getTime()),
  );

  if (clipped.length === 0) return [{ ...range, depth: shallow }];

  const out: RangeSegment[] = [];
  let cursor = lo;
  for (const c of clipped) {
    if (c.from.getTime() > cursor) {
      out.push({ from: new Date(cursor), to: c.from, depth: shallow });
    }
    out.push({ from: c.from, to: c.to, depth: 'full' });
    cursor = c.to.getTime();
  }
  if (cursor < hi) out.push({ from: new Date(cursor), to: new Date(hi), depth: shallow });

  return out;
}

const DAY = 86_400_000;

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** How many days a segment spans, rounded up, minimum 1. */
export function spanDays(seg: DateRange): number {
  return Math.max(1, Math.ceil((seg.to.getTime() - seg.from.getTime()) / DAY));
}

/**
 * Human duration for a segment.
 *
 * Sub-day spans are not rounded up to `1d`: the gap between the last session and
 * now is routinely a few hours, and printing "1d no data" for it invents most of
 * a day of missing history.
 */
export function spanLabel(seg: DateRange): string {
  const ms = seg.to.getTime() - seg.from.getTime();
  if (ms < DAY) {
    const hours = Math.round(ms / 3_600_000);
    return hours <= 0 ? '<1h' : `${hours}h`;
  }
  return `${Math.ceil(ms / DAY)}d`;
}

/**
 * The coverage notice printed above a report.
 *
 * Every line states what we have, never a cause we cannot establish. `none`
 * deliberately does **not** say "the harness deleted these": a gap between
 * sessions is far more often a period nobody worked than one where data was
 * lost, and we have no way to tell the two apart for any period before our
 * first scan. Blaming deletion for a quiet weekend is the same class of error
 * as claiming coverage we do not have.
 */
export function describeCoverage(segments: RangeSegment[]): string[] {
  const out: string[] = [];
  for (const s of segments) {
    const period = `${iso(s.from)} → ${iso(s.to)}`;
    const span = spanLabel(s);
    switch (s.depth) {
      case 'full':
        out.push(`  ${period}  (${span})  full depth — tool calls, outcomes, all detectors`);
        break;
      case 'prompt-level':
        out.push(`  ${period}  (${span})  prompt-level only — no transcript survives for this period`);
        break;
      case 'none':
        out.push(`  ${period}  (${span})  no transcripts cover this period`);
        break;
      case 'unscanned':
        out.push(`  ${period}  (${span})  not scanned yet — run \`agentsensei scan\``);
        break;
    }
  }
  return out;
}
