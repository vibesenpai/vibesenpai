/**
 * The session-start report, delivered via `systemMessage` only, never `additionalContext`,
 * so it reaches the user and not the model. Terse: it prints at the top of every session.
 */

import { approx } from './cost.ts';
import { basename } from 'node:path';
import type { Standing } from './standing.ts';
import { human, shortenPath } from './format.ts';
import { reasonLabel } from './detect/labels.ts';

/** How many dimensions the block will name before deferring to `now`. */
export const MAX_DIMENSIONS = 2;

/** One dimension, stated as a fact: no imperative verb, no severity word. */
export function dimensionLine(d: Standing['dimensions'][number]): string {
  const n = d.occurrences;
  const what =
    d.dimension === 'edit_retry'
      ? `${n} edit${n === 1 ? '' : 's'} ${n === 1 ? 'was' : 'were'} rejected and retried`
      : d.dimension === 'redundant_call'
        ? `${n} call${n === 1 ? '' : 's'} ${n === 1 ? 'was' : 'were'} repeated with the same answer`
        : `${d.dimension} ×${n}`;

  if (d.files > 1) return `${what}, across ${d.files} files`;
  return what;
}

/** Where it happened, on its own line so neither wraps at ~70 columns. See DECISIONS.md D63. */
export function whereLine(d: Standing['dimensions'][number]): string {
  if (d.top === undefined) return '';
  const name = shortenPath(basename(d.top.subject), 44);
  return d.files > 1 ? `     most often ${name}` : `     in ${name}`;
}

/** The reasons, one per line, biggest first. */
export function reasonLines(reasons: Record<string, number>): string[] {
  return Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `     ${n}  ${reasonLabel(key)}`);
}

/** The cache line, only when a rebuild happened (DECISIONS.md D66); never a `cacheRead` ratio (D49). */
export function cacheLine(s: Standing): string {
  const r = s.rebuilds;
  if (r === undefined || r.count === 0 || r.tokens === 0) return '';
  const times = r.count === 1 ? 'once' : `${r.count} times`;
  return `The cache was rebuilt from scratch ${times} — ${human(r.tokens)} tokens written again`;
}

/** Judge findings by dimension, passed in because persisted `Standing` holds the rule tier only. */
type JudgedTally = { dimension: string; count: number }[];

export function reportBlock(
  s: Standing | undefined,
  detail?: string,
  judged: JudgedTally = [],
  /** Judge findings a dismissal is hiding. The rule tier's count is on `s`. */
  judgedDismissed = 0,
): string {
  if (s === undefined) return '';

  // Names itself, since it appears in a session the user did not invoke it in. The token figure
  // is the rule tier's only: judge findings carry no price.
  const wasted = Object.values(s.wastedTokens).reduce((n, w) => n + w.written, 0);
  const ruleCount = s.dimensions.reduce((n, d) => n + d.occurrences, 0);
  const judgedTotal = judged.reduce((n, j) => n + j.count, 0);
  const headline =
    wasted > 0
      ? ` · ${approx(wasted)} tokens discarded on ${ruleCount} finding${ruleCount === 1 ? '' : 's'}`
      : ruleCount + judgedTotal > 0
        ? ` · ${ruleCount + judgedTotal} finding${ruleCount + judgedTotal === 1 ? '' : 's'}`
        : '';
  const head =
    `agentsensei · your last ${s.sessions} session${s.sessions === 1 ? '' : 's'}${headline}`;
  const lines: string[] = [];

  for (const d of s.dimensions.slice(0, MAX_DIMENSIONS)) {
    lines.push(`  ${dimensionLine(d)}`);
    const where = whereLine(d);
    if (where !== '') lines.push(where);
  }
  // Reasons shown once for all dimensions above, not per dimension.
  if (lines.length > 0) lines.push(...reasonLines(s.reasons));

  // Judge findings as one line, so five dimensions cannot swamp the block.
  if (judgedTotal > 0) {
    const names = judged
      .slice()
      .sort((a, b) => b.count - a.count)
      .slice(0, 2)
      .map((j) => j.dimension);
    const more = judged.length > names.length ? `, +${judged.length - names.length} more` : '';
    lines.push(
      `  ${judgedTotal} flagged by a model — ${names.join(', ')}${more}`,
    );
  }

  const hidden = s.dimensions.length - MAX_DIMENSIONS;
  if (hidden > 0) lines.push(`  …${hidden} more`);

  const cost = cacheLine(s);
  if (cost !== '') lines.push(`  ${cost}`);

  if (lines.length === 0) {
    // Reached only when both tiers are empty. Said rather than omitted, so it does not read as broken.
    const dismissed = (s.dismissed ?? 0) + judgedDismissed;
    return dismissed > 0
      ? `\n${head} · nothing to flag across ${s.edits} edits · ${dismissed} dismissed`
      : `\n${head} · nothing to flag across ${s.edits} edits`;
  }

  if (s.unreadable > 0) {
    // Never hidden: a report must not claim more coverage than it has.
    lines.push(`  ${s.unreadable} session${s.unreadable === 1 ? '' : 's'} could not be read`);
  }

  if (detail !== undefined && detail !== '') lines.push(`  ${detail}`);
  // Leading newline so the block starts clear of the harness's `SessionStart:startup says:` prefix.
  return `\n${[head, ...lines].join('\n')}`;
}

/** The next surface to run, printed at the end of each one; kept in one place so the rungs agree. */
export function nextRung(from: 'block' | 'insights' | 'report' | 'fix'): string {
  switch (from) {
    case 'block':
      return 'Run /agentsensei:insights for the exact turns';
    case 'insights':
      return 'Run /agentsensei:report for more details';
    case 'report':
      return 'Run /agentsensei:fix for possible fixes';
    case 'fix':
      return 'Run /agentsensei:report for more details';
  }
}
