/**
 * `fix` — the second output.
 *
 * CLAUDE.md allows exactly two: **evidence**, and **something applicable**. Up
 * to now the project shipped only the first, which makes it a report rather
 * than the thing it set out to be.
 *
 * ── Exactly one recommendation ─────────────────────────────────────────────
 *
 * Not a list. `docs/artifacts.md` settles this from behaviour-change research:
 * a single specific goal beats a list of them, and a tool that returns six
 * things to fix has returned nothing to do. So `recommend()` returns one
 * `Recommendation` or none.
 *
 * ── Artifact kinds, by measured effect ─────────────────────────────────────
 *
 * ```
 *   GUARD    a hook; mechanical, cannot be ignored   ~10.2% of gap closed, p=0.022
 *   PROMPT   evidence-loaded text for the agent      the default
 *   MEMORY   a CLAUDE.md diff                        ~3.6%, budget-limited
 *   REPORT   stated cost, no artifact available      honest, not a cop-out
 * ```
 *
 * **`edit_retry` cannot be guarded, and that is not a gap in the design.** A
 * `PreToolUse` guard prevents an action — but the harness *already* refuses
 * these edits. The waste is the round-trip, not an unprevented write, so there
 * is nothing left for a guard to stop. That is why the strongest kind is absent
 * here and the honest exits are `PROMPT` and `MEMORY`.
 *
 * ── Nothing is applied ─────────────────────────────────────────────────────
 *
 * This module returns text. Writing to `CLAUDE.md`, or adopting a prompt for a
 * session, is the user's decision and happens elsewhere, after they say yes.
 */

import type { Standing } from './standing.ts';
import { reasonLabel } from './report-line.ts';
import { approx } from './cost.ts';
import { bold, cyan, dim, green, pad, rule, yellow } from './style.ts';

export type ArtifactKind = 'GUARD' | 'PROMPT' | 'MEMORY' | 'REPORT';

export type Recommendation = {
  kind: ArtifactKind;
  dimension: string;
  /** What was measured, in the user's own data. Always present. */
  evidence: string;
  /**
   * Text to hand the agent for *this session*.
   *
   * Absent on a `REPORT`, which is the honest case where no artifact exists.
   */
  prompt?: string;
  /** A `CLAUDE.md` line, for making it stick beyond this session. */
  memory?: string;
  /**
   * Why this and not something else — so a recommendation can be argued with.
   *
   * A tool that says "do this" without saying "because you did that 528 times"
   * is advice, which is out of scope.
   */
  because: string;
  /**
   * What this reason has already cost, in tokens.
   *
   * **Past cost, not a forecast.** "You will save N" is a prediction the data
   * cannot support — adopting a brief changes the session being measured, which
   * the note at the bottom of the render already admits. "This cost N" is the
   * claim the evidence actually makes.
   *
   * Absent when the standing predates the measurement or the reason has no
   * priced instances.
   */
  cost?: { written: number; received: number };
};

/**
 * What each reason can actually be fixed with.
 *
 * Keyed on the harness's own reason, not the dimension: `not-read-first` and
 * `string-not-found` are both `edit_retry`, and they need different changes.
 * A reason absent from this table has no artifact, which is a real answer.
 */
const ARTIFACTS: Record<string, { prompt: string; memory: string }> = {
  'not-read-first': {
    prompt:
      'For the rest of this session: read a file before editing it. ' +
      'Do not issue an Edit or Write against a path you have not read in this session.',
    memory: '- Read a file before editing it; never edit a path unread this session.',
  },
  'string-not-found': {
    prompt:
      'For the rest of this session: before editing, re-read the exact region you are about to ' +
      'change if anything may have altered it since you last read it — a linter, a formatter, ' +
      'another tool, or your own earlier edit.',
    memory: '- Re-read right before editing if anything may have changed the file.',
  },
  'stale-read': {
    prompt:
      'For the rest of this session: when an edit is refused as stale, re-read the file before ' +
      'retrying rather than reissuing the same edit.',
    memory: '- After a stale-read refusal, re-read before retrying the edit.',
  },
  'ambiguous-target': {
    prompt:
      'For the rest of this session: when replacing text that appears more than once, quote ' +
      'enough surrounding context to make the match unique rather than retrying the short form.',
    memory: '- Quote enough context to make an edit target unique.',
  },
};

/** Dimensions with no artifact: real, measurable, and nothing honest to offer. */
const REPORT_ONLY = new Set(['redundant_call']);

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The one thing worth changing, or nothing.
 *
 * Chosen by occurrences among dimensions that **have** an artifact, so a rare
 * report-only dimension never outranks a frequent fixable one — and a
 * recommendation is never manufactured for a dimension whose honest exit is a
 * report.
 */
export function recommend(s: Standing | undefined): Recommendation | undefined {
  if (s === undefined || s.dimensions.length === 0) return undefined;

  const fixable = s.dimensions.filter((d) => !REPORT_ONLY.has(d.dimension));
  const target = fixable[0] ?? s.dimensions[0];
  if (target === undefined) return undefined;

  const sessions = `${plural(s.sessions, 'session')}`;

  if (REPORT_ONLY.has(target.dimension)) {
    return {
      kind: 'REPORT',
      dimension: target.dimension,
      evidence: `${plural(target.occurrences, 'occurrence')} across ${sessions}`,
      because:
        'No artifact exists for this one. Saying so is better than manufacturing a tip ' +
        'that would not survive being asked "why".',
    };
  }

  // The dominant reason decides the artifact: the same dimension needs a
  // different change depending on why the harness refused.
  // Tie broken by reason key, so a 2-2 split does not flip between runs. The
  // choice is arbitrary either way; being *stably* arbitrary is what matters,
  // because a recommendation that changes on re-run cannot be followed.
  const ranked = Object.entries(s.reasons).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = ranked.find(([key]) => ARTIFACTS[key] !== undefined);

  if (top === undefined) {
    return {
      kind: 'REPORT',
      dimension: target.dimension,
      evidence: `${plural(target.occurrences, 'occurrence')} across ${sessions}`,
      because:
        'The harness did not give a reason we have an artifact for, so there is nothing ' +
        'specific enough to recommend. The finding still stands.',
    };
  }

  const [reason, n] = top;
  const artifact = ARTIFACTS[reason] as { prompt: string; memory: string };
  // `?.` although the type says it is there: `readStanding` casts rather than
  // validates, so a file written by an older version reads as undefined.
  const cost = s.wastedTokens?.[reason];
  const where =
    target.top !== undefined && target.files > 1
      ? `, most often in ${target.top.subject.split('/').pop() ?? target.top.subject}`
      : '';

  return {
    kind: 'PROMPT',
    dimension: target.dimension,
    evidence:
      `${plural(target.occurrences, 'edit')} rejected and retried across ${sessions}` +
      `${where} — ${n} because ${reasonLabel(reason)}`,
    prompt: artifact.prompt,
    memory: artifact.memory,
    because: `${reasonLabel(reason)} is the most common reason, at ${n} of ${target.occurrences}.`,
    ...(cost !== undefined && cost.written + cost.received > 0 ? { cost } : {}),
  };
}

/**
 * The recommendation, rendered.
 *
 * States what was measured before what to do about it, because the evidence is
 * what makes the suggestion arguable — and an unarguable suggestion is advice.
 */
export function renderFix(r: Recommendation | undefined, preset: string, muted: string[] = []): string {
  const lines: string[] = [];
  const W = 68;

  if (r === undefined) {
    lines.push(dim('nothing to recommend yet.'));
    lines.push(
      `  ${dim('no findings in your history, or no standing computed — run `standing --refresh`.')}`,
    );
    return lines.join('\n');
  }

  // The header names the dimension and the artifact kind. The kind is the
  // strongest thing on the line because it says what you are being handed —
  // a prompt to paste, a rule to keep, or a figure and no artifact at all.
  lines.push(
    '',
    `  ${dim('one thing to try')}  ${yellow(r.dimension)}  ${green(`[${r.kind}]`)}`,
    `  ${rule(W)}`,
    '',
  );

  // `measured` / `because` / `cost` share a label column, so the three read as
  // one block rather than three sentences. The cost is last because it is the
  // consequence of the two above it.
  const field = (label: string, text: string, style: (t: string) => string = (t) => t): void => {
    for (const [i, l] of wrap(text, 54).entries()) {
      lines.push(`  ${pad(i === 0 ? label : '', 10, dim)} ${style(l)}`);
    }
  };

  field('measured', r.evidence);
  field('because', r.because);
  if (r.cost !== undefined) {
    // Bold on the figure only: the sentence around it is context, the number is
    // the thing worth carrying away.
    lines.push(
      `  ${pad('cost', 10, dim)} ${bold(`${approx(r.cost.written)} tokens`)} ${dim('written and discarded')}`,
    );
  }
  lines.push('');

  if (r.prompt !== undefined) {
    lines.push(`  ${cyan('▸')} ${dim('for this session — paste or adopt')}`, '');
    for (const l of wrap(r.prompt, 60)) lines.push(`      ${l}`);
    lines.push('');
  }
  if (r.memory !== undefined) {
    lines.push(`  ${cyan('▸')} ${dim('to make it stick, add to CLAUDE.md')}`, '');
    lines.push(`      ${r.memory}`, '');
  }
  if (r.kind === 'REPORT') {
    lines.push(`  ${dim('no artifact for this one — the cost is stated, and that is all.')}`, '');
  }

  // The honesty note the design requires: adopting a brief changes the session
  // being measured, so the next report cannot call it an improvement.
  if (r.prompt !== undefined) {
    for (const l of wrap(
      'adopting this changes the session it is measuring, so this dimension will read as suppressed rather than improved until you drop it again.',
      62,
    )) {
      lines.push(`  ${dim(l)}`);
    }
    lines.push('');
  }

  // Say what it chose from. One live detector would otherwise read as "there is
  // only one thing you could improve".
  lines.push(
    `  ${rule(W)}`,
    `  ${dim(`chosen from preset "${preset}"${muted.length > 0 ? ` · muted: ${muted.join(', ')}` : ''}`)}`,
  );
  return lines.join('\n');
}

/** Wrap to a width, on word boundaries. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line === '') line = word;
    else if (`${line} ${word}`.length <= width) line = `${line} ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line !== '') out.push(line);
  return out;
}
