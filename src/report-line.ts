/**
 * The session-start report — the one thing everybody sees.
 *
 * ── The channel, established from Anthropic's own plugins ──────────────────
 *
 * A hook returns `{"systemMessage": "..."}` and it renders in the **user's**
 * main window. The `plugin-dev` skill describes `systemMessage` as "Explanation
 * for Claude", which is wrong: `claude-security` prints an ASCII-art logo box
 * through it, and `security-guidance` names it in a comment as a *"user-visible
 * TUI message"* — distinguishing it from `hookSpecificOutput.additionalContext`,
 * which that same comment calls SessionStart's channel for surfacing text to
 * "both the model and the user".
 *
 * That distinction is the whole reason this surface is honest. We emit
 * `systemMessage` and never `additionalContext`, so nothing reaches the model
 * and the tool stays outside the session it measures. The earlier design had to
 * weigh an observer effect against being visible; that trade turned out not to
 * exist.
 *
 * ── Why it is terse ────────────────────────────────────────────────────────
 *
 * This prints at the top of every session. Anything that is not worth reading
 * every single time is worth putting in `agentsensei now` instead, which is
 * why file churn never appears here and the dimension list is capped.
 */

import type { Standing } from './standing.ts';
import { CORPUS } from './render.ts';

/** How many dimensions the block will name before deferring to `now`. */
export const MAX_DIMENSIONS = 2;

/**
 * Harness reason keys as English.
 *
 * The key is an identifier — stable, greppable, and not language. A reader of
 * the report should not have to decode `not-read-first`.
 */
const REASON_LABELS: Record<string, string> = {
  'not-read-first': 'not read first',
  'string-not-found': 'text did not match',
  'stale-read': 'changed after reading',
  'ambiguous-target': 'matched several places',
  'no-op': 'no change',
  'missing-file': 'missing file',
  'bad-arguments': 'malformed call',
};

export function reasonLabel(key: string): string {
  return REASON_LABELS[key] ?? key.replace(/-/g, ' ');
}

/**
 * One dimension, stated as a fact.
 *
 * No imperative verb and no severity word — the same rule the ambient nudge
 * had, for the same reason: this is a report someone reads at the start of
 * every session, and a tool that nags about something it is occasionally wrong
 * about gets uninstalled. The advice lives in `now`, where there is room to
 * show the evidence that justifies it.
 */
export function dimensionLine(d: Standing['dimensions'][number]): string {
  const n = d.occurrences;
  switch (d.dimension) {
    case 'edit_retry':
      return `${n} edit${n === 1 ? '' : 's'} refused then retried`;
    case 'redundant_call':
      return `${n} identical call${n === 1 ? '' : 's'} repeated, same answer`;
    default:
      return `${d.dimension} ×${n}`;
  }
}

/** The reason tally, biggest first, as one line. */
export function reasonsLine(reasons: Record<string, number>): string {
  const parts = Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `${n} ${reasonLabel(key)}`);
  return parts.join(' · ');
}

/**
 * The cost line, or nothing.
 *
 * Quoted against the corpus so the number has a reference point: `7.4×` alone
 * means nothing, `7.4× (median 12.0)` is a statement. `cacheRead` is absent, as
 * everywhere else — it re-counts the whole prefix per call, so any ratio built
 * on it is pinned near 1 by construction.
 */
export function costLine(s: Standing): string {
  if (s.tokens.output === 0) return '';
  const ratio = s.tokens.cacheCreation / s.tokens.output;
  const ref =
    ratio >= CORPUS.reingestP90
      ? `corpus p90 ${CORPUS.reingestP90.toFixed(1)}`
      : `median ${CORPUS.reingestP50.toFixed(1)}`;
  return `context re-ingested ${ratio.toFixed(1)}× output (${ref})`;
}

/**
 * The whole block.
 *
 * Returns `''` when there is no standing at all — the very first session after
 * an install, before the detached pass has finished. Silence is right there:
 * the pass is running and will have something next time.
 */
export function reportBlock(s: Standing | undefined): string {
  if (s === undefined) return '';

  const head = `agentsensei · ${s.sessions} session${s.sessions === 1 ? '' : 's'} · ${s.edits} edits`;
  const lines: string[] = [];

  for (const d of s.dimensions.slice(0, MAX_DIMENSIONS)) {
    lines.push(`  ${dimensionLine(d)}`);
  }
  // The reasons belong to the dimensions above; shown once rather than per
  // dimension, because with two of them a per-dimension breakdown is longer
  // than the findings it explains.
  const reasons = reasonsLine(s.reasons);
  if (lines.length > 0 && reasons !== '') lines.push(`      ${reasons}`);

  const hidden = s.dimensions.length - MAX_DIMENSIONS;
  if (hidden > 0) lines.push(`  …${hidden} more`);

  const cost = costLine(s);
  if (cost !== '') lines.push(`  ${cost}`);

  if (lines.length === 0) {
    // Said in one line rather than omitted. Silence would read as broken, and
    // inventing something to report would be worse than either.
    return `${head} · nothing to flag`;
  }

  if (s.unreadable > 0) {
    // Never hidden: a report that quietly covered fewer sessions than it claims
    // is the implied-coverage problem the depth labelling exists to prevent.
    lines.push(`  ${s.unreadable} session${s.unreadable === 1 ? '' : 's'} could not be read`);
  }

  lines.push('  `agentsensei now` for this session');
  return [head, ...lines].join('\n');
}
