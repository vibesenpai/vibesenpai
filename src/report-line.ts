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

import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Standing } from './standing.ts';
import { CORPUS, shortenPath } from './render.ts';

/** How many dimensions the block will name before deferring to `now`. */
export const MAX_DIMENSIONS = 2;

/**
 * Harness reason keys as English.
 *
 * The key is an identifier — stable, greppable, and not language. A reader of
 * the report should not have to decode `not-read-first`.
 */
const REASON_LABELS: Record<string, string> = {
  'not-read-first': "the file wasn't read first",
  'string-not-found': "the text didn't match",
  'stale-read': 'the file changed after it was read',
  'ambiguous-target': 'the text matched several places',
  'no-op': 'the edit changed nothing',
  'missing-file': "the file doesn't exist",
  'bad-arguments': 'the call was malformed',
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
  const what =
    d.dimension === 'edit_retry'
      ? `${n} edit${n === 1 ? '' : 's'} ${n === 1 ? 'was' : 'were'} rejected and retried`
      : d.dimension === 'redundant_call'
        ? `${n} call${n === 1 ? '' : 's'} ${n === 1 ? 'was' : 'were'} repeated with the same answer`
        : `${d.dimension} ×${n}`;

  if (d.files > 1) return `${what}, across ${d.files} files`;
  return what;
}

/**
 * Where it happened, as its own line.
 *
 * "4 edits" with no subject prompted the first reader to ask "4 *what* edits?".
 * One name answers that — enough to recognise and act on, while the rest stays
 * a count, so the block is a fixed height however many files are involved.
 *
 * Split from `dimensionLine` because together they ran to ~87 characters and
 * wrapped in a terminal showing ~70.
 */
export function whereLine(d: Standing['dimensions'][number]): string {
  if (d.top === undefined) return '';
  const name = shortenPath(basename(d.top.subject), 44);
  return d.files > 1 ? `     most often ${name}` : `     in ${name}`;
}

/**
 * The reasons, one per line, biggest first.
 *
 * One per line rather than `·`-separated: these are the only part a reader can
 * act on, and a row of fragments reads as a machine talking.
 */
export function reasonLines(reasons: Record<string, number>): string[] {
  return Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `     ${n}  ${reasonLabel(key)}`);
}

/**
 * The cost line — **only when it is unusual**, and as a sentence.
 *
 * It used to print every session as `context re-ingested 7.2× output (median
 * 12.0)`. The person who built the metric could not read it:
 *
 * > *"is helllaaaa confusing. What does that even mean. Even I don't know."*
 *
 * That is decisive. A ratio of cache-creation to output tokens is meaningful
 * only against other sessions, so below the threshold it says "you are normal"
 * forever, and above it the number still needs decoding. Now its **presence**
 * is the signal and the words carry the meaning — the ratio itself stays in
 * `now`, where there is room to explain it.
 *
 * `cacheRead` is absent here as everywhere: it re-counts the whole prefix per
 * call, so any ratio built on it is pinned near 1 by construction.
 */
export function costLine(s: Standing): string {
  if (s.tokens.output === 0) return '';
  const ratio = s.tokens.cacheCreation / s.tokens.output;
  if (ratio < CORPUS.reingestP90) return '';
  return 'Claude rebuilt its context far more often than usual — top 10% of sessions';
}

/**
 * Is a command actually runnable, or would telling someone to type it be a lie?
 *
 * The report used to end with `` `agentsensei now` for this session `` on every
 * machine. **On the machine it was written on, that command does not exist** —
 * no build, nothing on PATH. The single actionable line in the most-seen output
 * the tool has pointed at something that could only fail, which is the fastest
 * possible way to lose a reader.
 *
 * Checked rather than assumed, and cheap: a few `access` calls at session start.
 */
export function commandPath(home: string): string {
  // The namespaced location: `.claude/commands/agentsensei/now.md` is
  // `/agentsensei:now`. See `src/install.ts`.
  return join(home, '.claude', 'commands', 'agentsensei', 'now.md');
}

/**
 * How to see the detail, in a form that actually runs on this machine.
 *
 * `/agentsensei` when the command file is installed, the working `node …` form
 * when it is not. **Checked, never assumed** — the first version printed
 * `agentsensei now` unconditionally, and on the machine it was written on that
 * command did not exist. The one actionable line in the most-seen output the
 * tool has pointed at something that could only fail.
 */
export function detailLine(repoRoot: string, home: string): string {
  return existsSync(commandPath(home))
    ? '/agentsensei:now for the exact turns'
    : `node --experimental-strip-types ${repoRoot}/src/cli.ts now`;
}

/**
 * The whole block.
 *
 * Returns `''` when there is no standing at all — the very first session after
 * an install, before the detached pass has finished. Silence is right there:
 * the pass is running and will have something next time.
 */
export function reportBlock(s: Standing | undefined, detail?: string): string {
  if (s === undefined) return '';

  // `report` rather than the bare tool name: the header has to say what this
  // *is*, not only who is talking.
  const head = `agentsensei report · your last ${s.sessions} session${s.sessions === 1 ? '' : 's'}`;
  const lines: string[] = [];

  for (const d of s.dimensions.slice(0, MAX_DIMENSIONS)) {
    lines.push(`  ${dimensionLine(d)}`);
    const where = whereLine(d);
    if (where !== '') lines.push(where);
  }
  // The reasons belong to the dimensions above; shown once rather than per
  // dimension, because with two of them a per-dimension breakdown is longer
  // than the findings it explains.
  if (lines.length > 0) lines.push(...reasonLines(s.reasons));

  const hidden = s.dimensions.length - MAX_DIMENSIONS;
  if (hidden > 0) lines.push(`  …${hidden} more`);

  const cost = costLine(s);
  if (cost !== '') lines.push(`  ${cost}`);

  if (lines.length === 0) {
    // Said in one line rather than omitted. Silence would read as broken, and
    // inventing something to report would be worse than either.
    return `\n${head} · nothing to flag across ${s.edits} edits`;
  }

  if (s.unreadable > 0) {
    // Never hidden: a report that quietly covered fewer sessions than it claims
    // is the implied-coverage problem the depth labelling exists to prevent.
    lines.push(`  ${s.unreadable} session${s.unreadable === 1 ? '' : 's'} could not be read`);
  }

  if (detail !== undefined && detail !== '') lines.push(`  ${detail}`);
  // Leading newline so the block starts on its own line rather than running on
  // from the harness's `SessionStart:startup says:` prefix. `claude-security`
  // does the same for the same reason.
  return `\n${[head, ...lines].join('\n')}`;
}
