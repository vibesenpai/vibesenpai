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

  if (r === undefined) {
    lines.push('nothing to recommend yet.');
    lines.push('  no findings in your history, or no standing computed — run `standing --refresh`.');
    return lines.join('\n');
  }

  lines.push(`one thing to try · ${r.dimension} · ${r.kind}`, '');
  for (const [i, l] of wrap(r.evidence, 56).entries()) {
    lines.push(`  ${i === 0 ? 'measured  ' : '          '} ${l}`);
  }
  for (const [i, l] of wrap(r.because, 56).entries()) {
    lines.push(`  ${i === 0 ? 'because   ' : '          '} ${l}`);
  }
  lines.push('');

  if (r.prompt !== undefined) {
    lines.push('  for this session — paste or adopt:', '');
    for (const l of wrap(r.prompt, 62)) lines.push(`      ${l}`);
    lines.push('');
  }
  if (r.memory !== undefined) {
    lines.push('  to make it stick, add to CLAUDE.md:', '');
    lines.push(`      ${r.memory}`, '');
  }
  if (r.kind === 'REPORT') {
    lines.push('  no artifact for this one — the cost is stated, and that is all.', '');
  }

  // The honesty note the design requires: adopting a brief changes the session
  // being measured, so the next report cannot call it an improvement.
  if (r.prompt !== undefined) {
    lines.push(
      '  note: adopting this changes the session it is measuring, so this',
      '        dimension will read as suppressed rather than improved until',
      '        you drop it again.',
      '',
    );
  }

  // Say what it chose from. One live detector would otherwise read as "there is
  // only one thing you could improve".
  lines.push(`  chosen from preset "${preset}"${muted.length > 0 ? ` · muted: ${muted.join(', ')}` : ''}`);
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
