import { isoDay } from './format.ts';
/**
 * Date ranges for the retrospective surface, each split by the depth it can be answered at,
 * so missing history is labelled rather than read as improvement. Pure: no clock, no filesystem.
 */

type Depth =
  /** Tool calls, outcomes, every detector. Within the catalog's coverage. */
  | 'full'
  /** Prompts only, from `history.jsonl`. Before the first scan. */
  | 'prompt-level'
  /** Nothing survives for this period. Reported, never silently empty. */
  | 'none'
  /** No scan has run yet. Distinct from `none`, which would imply data loss. */
  | 'unscanned';

export type DateRange = { from: Date; to: Date };

type RangeSegment = DateRange & { depth: Depth };

/** Parse `--last 7d` / `30d` / `12w` / `6m`. Undefined, not a throw, on a malformed value. */
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

type RangeInput = {
  last?: string;
  since?: string;
  until?: string;
};

type RangeResult =
  | { ok: true; range: DateRange }
  | { ok: false; error: string };

/** Resolve the range flags into one window. `--last` excludes `--since`/`--until`. */
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
    // Default: the last 7 days.
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

type CoverageInput = {
  /** One interval per session, any order, overlaps allowed, so gaps between sessions stay visible. */
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
 * Split a range into fully and shallowly answerable parts: chronological, non-overlapping,
 * and never empty.
 */
export function segmentByDepth(range: DateRange, cov: CoverageInput): RangeSegment[] {
  // Never looked, versus looked and found nothing.
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

/** Human duration for a segment. Sub-day spans show hours, not a rounded-up `1d`. */
function spanLabel(seg: DateRange): string {
  const ms = seg.to.getTime() - seg.from.getTime();
  if (ms < DAY) {
    const hours = Math.round(ms / 3_600_000);
    return hours <= 0 ? '<1h' : `${hours}h`;
  }
  return `${Math.ceil(ms / DAY)}d`;
}

/**
 * The coverage notice printed above a report. States what we have, never a cause: `none`
 * does not claim deletion, since a gap is usually a period nobody worked.
 */
export function describeCoverage(segments: RangeSegment[]): string[] {
  const out: string[] = [];
  for (const s of segments) {
    const period = `${isoDay(s.from)} → ${isoDay(s.to)}`;
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
        out.push(`  ${period}  (${span})  not scanned yet — run \`vibesenpai scan\``);
        break;
    }
  }
  return out;
}
