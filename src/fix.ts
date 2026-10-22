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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Standing } from './standing.ts';
import type { JudgedFinding } from './judge-store.ts';
import { reasonLabel } from './report-line.ts';
import { approx } from './cost.ts';
import { bold, cyan, dim, green, pad, rule, yellow } from './style.ts';

/**
 * What kind of change this is — and the ordering is the docs' own.
 *
 * Claude Code's documentation splits its surfaces three ways, and the wording
 * matters because it is the difference between a fix and a hope:
 *
 * ```
 *   DETERMINISTIC   permissions + command hooks   "enforced by Claude Code,
 *                                                  not by the model"
 *   MODEL-JUDGED    prompt / agent hooks          "a model's judgment, not a
 *                                                  guarantee"
 *   PROSE           CLAUDE.md, .claude/rules/      "context, not enforced
 *                   memory, output styles           configuration"
 * ```
 *
 * `GUARD` and `VERIFY` are deterministic. `CONFIG` shifts what the harness
 * does. `PROMPT` is model-judged. `MEMORY` is prose, and measured at
 * **+0.066 pts** across 753 rules in 410 repos, so it is never the default.
 *
 * Two more that are not harness surfaces at all, and both were missing:
 *
 * `EXTERNAL` — some of these the industry already solved, and pointing at a
 * pattern beats inventing a worse one. `REPORT` — **no artifact exists, and
 * that is an answer.** Three of our seven dimensions end here, including one
 * where the harness already enforces the thing a rule would ask for.
 */
export type ArtifactKind =
  | 'GUARD'
  | 'VERIFY'
  | 'CONFIG'
  | 'PROMPT'
  | 'MEMORY'
  | 'EXTERNAL'
  | 'REPORT';

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
  /**
   * A `CLAUDE.md` line, for making it stick beyond this session.
   *
   * **Budget-checked, and often absent even when one could be written.**
   * `docs/artifacts.md` measures a prose rule at +0.066 pts and documents
   * `CLAUDE.md` degrading past ~500 words, so an unconditional line is how a
   * coach makes its user worse over time.
   */
  memory?: string;
  /**
   * The settings fragment or hook a `GUARD`, `VERIFY` or `CONFIG` needs.
   *
   * **Printed, never written.** The never-touch-your-config rule is not relaxed
   * because the research likes hooks.
   */
  config?: { what: string; snippet: string; costs: string };
  /** What this costs the user, for a mechanism that can refuse to finish. */
  external?: { what: string; where: string };
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

/**
 * What actually fixes each dimension, researched rather than assumed.
 *
 * ── Three of seven have no fix, and that is the finding ────────────────────
 *
 * `redundant_call` — re-reading a file is cheap and frequently correct. A
 * `PreToolUse` cache on `Read` is buildable but must reset on compaction, since
 * after a compact the content is gone and denying the re-read would strand the
 * model. Not worth it.
 *
 * `edit_retry` / `not-read-first` — **the harness already refuses unread
 * edits.** A rule asking for it is `docs/artifacts.md`'s *ceremonial* category
 * by definition: 66.7% of rules describe behaviour that already complied.
 * Saying "nothing to do, the harness has this" is the useful answer.
 *
 * `other` — unknown by construction. The descriptor is the point: accumulate
 * them and read them, rather than inventing a dimension.
 *
 * ── Where a mechanism does exist, it is deterministic ──────────────────────
 *
 * `constraint_violation` and `overreach` share one: a `Stop` hook comparing
 * `git diff --name-only` against an allowlist. It beats interception because
 * `permissions.deny` only matches the forms it is written for — `Bash(pnpm add
 * *)` misses `npx pnpm add`, `pnpm -C dir add`, `sh -c 'pnpm add'`, `yarn add`
 * and editing `package.json` by hand — and the docs state plainly that a Bash
 * rule "isn't a security boundary". Deny rules are offered as a cheap first
 * layer with that limit named, never as sufficient.
 *
 * `inaccurate_self_report` is the cleanest: a `Stop` hook runs the real check
 * and exits 2 with the output. The hook input carries `last_assistant_message`
 * **and** `transcript_path`, so a script can compare the claim against the
 * transcript. This is the verify-gated-completion pattern, and no major vendor
 * ships one — so `EXTERNAL` is a legitimate alternative.
 *
 * `misread_intent` has no gate. Clarification recovers nearly all the lost
 * ground (69.40% against 70.80% with the full issue, arXiv 2603.26233) but
 * over-asking has a real cost, and agents ask about *which target* far more
 * readily than *what you meant*. The harness itself shifts the ask rate from
 * 31.8% to 10.5% across scaffolds, which is why `CONFIG` outranks `PROMPT`
 * here.
 */
const REPORT_ONLY = new Set(['redundant_call', 'other']);

/** A `Stop` hook is the one mechanism that sees every write surface. */
const STOP_HOOK_COSTS =
  'This can stop a turn from finishing and send the agent back to work. ' +
  'Claude Code will not let that repeat more than 8 times in a row.';

type DimensionFix = {
  kind: ArtifactKind;
  prompt?: string;
  config?: { what: string; snippet: string; costs: string };
  external?: { what: string; where: string };
  because: string;
};

const BY_DIMENSION: Record<string, DimensionFix> = {
  constraint_violation: {
    kind: 'VERIFY',
    config: {
      what: 'a Stop hook that checks the diff before the turn can end',
      snippet: `{ "hooks": { "Stop": [{ "hooks": [{ "type": "command",
    "command": "git diff --name-only | grep -qE '<paths you said not to touch>' && { echo 'touched a path you asked me not to' >&2; exit 2; } || true" }] }] } }`,
      costs: STOP_HOOK_COSTS,
    },
    prompt:
      'For the rest of this session, before any edit or command: check it ' +
      'against every constraint stated earlier in this conversation, and say ' +
      'which one you checked against.',
    // The evidence for this wording lives in `docs/artifacts.md` and the
    // header above. It is deliberately NOT in the output: a user reading a
    // finding about their own session does not need a literature review, and
    // "+0.066 pts across 753 rules" is a sentence that informs nobody who did
    // not already know what it meant.
    because:
      'A hook is checked by Claude Code itself, so it holds whether or not the ' +
      'model remembers. Asking in a prompt only works while it is paying ' +
      'attention.',
  },
  overreach: {
    kind: 'GUARD',
    config: {
      what: 'a Stop hook that holds the diff to what was asked',
      snippet: `{ "hooks": { "Stop": [{ "hooks": [{ "type": "command",
    "command": "git diff --name-only | grep -vqE '<paths this task should touch>' && { echo 'changed files outside the task' >&2; exit 2; } || true" }] }] } }`,
      costs: STOP_HOOK_COSTS,
    },
    prompt:
      'For the rest of this session: do only what was asked. If you think ' +
      'something adjacent needs doing, say so and wait rather than doing it.',
    because:
      'Nothing can tell "too much" from "just enough" by reading the request — ' +
      'but the list of changed files is checkable. Blocking the tools is not ' +
      'enough on its own, because a shell command can write files too.',
  },
  inaccurate_self_report: {
    kind: 'VERIFY',
    config: {
      what: 'a Stop hook that runs the check instead of trusting the claim',
      snippet: `{ "hooks": { "Stop": [{ "hooks": [{ "type": "command",
    "command": "<your test command> || { echo 'tests are not passing' >&2; exit 2; }" }] }] } }`,
      costs: STOP_HOOK_COSTS,
    },
    external: {
      what: 'verify-gated completion — a read-only verifier reruns build and tests and gates on the outcome, not the claim',
      where: 'https://learn.agentpatterns.ai/multi-agent/verify-gated-completion/',
    },
    prompt:
      'For the rest of this session: do not report work as done or passing ' +
      'unless a command in this session shows it. Quote the output.',
    because:
      'Whether the tests pass is not a matter of opinion, so it is worth ' +
      'checking rather than trusting. Running the command settles it; reading ' +
      'the summary does not.',
  },
  misread_intent: {
    kind: 'CONFIG',
    config: {
      what: 'plan mode, so the reading gets agreed before the work starts',
      snippet: 'shift+tab to cycle into plan mode, or `claude --permission-mode plan`',
      costs:
        'Slower, because you approve a plan before work starts. Worth it for ' +
        'anything ambiguous, and in the way for anything obvious.',
    },
    prompt:
      'For the rest of this session: before acting on anything ambiguous, ' +
      'state the reading you are acting on in one line and wait.',
    because:
      'Nothing can check whether it understood you — that is the one thing ' +
      'only you can confirm. Agreeing the plan first recovers almost ' +
      'everything a vague request costs.',
  },
};

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
export function recommend(
  s: Standing | undefined,
  judged: JudgedFinding[] = [],
): Recommendation | undefined {
  // ── Judge findings outrank rule findings, and the reason is the mechanism ──
  //
  // `fix` used to read only `Standing`, which holds the rule detectors. So on a
  // machine whose judge had found two `constraint_violation`s — including
  // "delete that prod.env from your memory" going unactioned — it reached past
  // them to offer an `edit_retry` prose rule for something the harness already
  // enforces.
  //
  // The ranking is not "newer is better": it is that a dimension with a
  // deterministic mechanism available outranks one whose honest answer is a
  // report. `BY_DIMENSION` is what knows which is which.
  const byDim = new Map<string, number>();
  for (const f of judged) byDim.set(f.dimension, (byDim.get(f.dimension) ?? 0) + 1);
  const judgedFix = [...byDim.entries()]
    .filter(([d]) => BY_DIMENSION[d] !== undefined)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];

  if (judgedFix !== undefined) {
    const [dimension, n] = judgedFix;
    const fix = BY_DIMENSION[dimension] as DimensionFix;
    const anchors = judged.filter((f) => f.dimension === dimension);
    const first = anchors[0] as JudgedFinding;
    const turns = anchors.flatMap((f) => f.turns).sort((a, b) => a - b);
    const where =
      turns.length > 1 ? `turns ${turns[0]}–${turns[turns.length - 1]}` : `turn ${turns[0] ?? '?'}`;
    return {
      kind: fix.kind,
      dimension,
      evidence:
        `${plural(n, 'time')} across your sessions, at ${where}` +
        (first.name !== undefined ? ` — ${first.name}` : '') +
        (first.quote !== undefined && first.quote !== '' ? `\n             "${first.quote.slice(0, 90)}"` : ''),
      because: fix.because,
      ...(fix.prompt !== undefined ? { prompt: fix.prompt } : {}),
      ...(fix.config !== undefined ? { config: fix.config } : {}),
      ...(fix.external !== undefined ? { external: fix.external } : {}),
    };
  }

  // ── A judged REPORT, held as a candidate rather than a last resort ───────
  //
  // Judge findings with no mechanism are still an answer, and `other` carries
  // the descriptors that are the only route to discovering a missing dimension.
  // Computing this as a candidate matters: the first version only reached it
  // when `Standing` was absent, which in practice is never — so the
  // descriptors were collected and then never shown.
  const judgedReport = ((): Recommendation | undefined => {
    const only = [...byDim.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (only === undefined) return undefined;
    const [dimension, n] = only;
    const descriptors = [
      ...new Set(
        judged
          .filter((f) => f.dimension === dimension && f.otherDescriptor !== undefined)
          .map((f) => f.otherDescriptor as string),
      ),
    ];
    return {
      kind: 'REPORT',
      dimension,
      evidence: `${plural(n, 'time')} across your sessions`,
      because:
        dimension === 'other'
          ? 'This is the escape hatch: a real problem none of the four ' +
            'dimensions describes. There is nothing to recommend yet — the ' +
            'point is to collect these until a pattern is visible' +
            (descriptors.length > 0 ? `. So far: ${descriptors.join('; ')}` : '.')
          : 'No mechanism exists for this one. The finding still stands.',
    };
  })();

  if (s === undefined || s.dimensions.length === 0) return judgedReport;

  const fixable = s.dimensions.filter((d) => !REPORT_ONLY.has(d.dimension));
  const target = fixable[0] ?? s.dimensions[0];
  if (target === undefined) return undefined;

  const sessions = `${plural(s.sessions, 'session')}`;

  if (REPORT_ONLY.has(target.dimension)) {
    // Both are reports; the judged one is about the collaboration and may
    // carry descriptors, so it is the more informative of two non-actions.
    if (judgedReport !== undefined) return judgedReport;
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

  // ── The harness already does this one ───────────────────────────────────
  //
  // `not-read-first` is the most common `edit_retry` reason and was the
  // default recommendation: "read a file before editing it". The harness
  // **already refuses** unread edits — `fix.ts` says so twenty lines up — so
  // the rule describes behaviour that already complied. `docs/artifacts.md`
  // measures that category at 66.7% of all rules and calls it ceremonial.
  //
  // Reporting it is more useful than a rule, because the user learns the
  // retries are the harness working rather than something to configure.
  if (reason === 'not-read-first') {
    if (judgedReport !== undefined) return judgedReport;
    const cost = s.wastedTokens?.[reason];
    return {
      kind: 'REPORT',
      dimension: target.dimension,
      evidence: `${plural(n, 'edit')} refused across ${sessions} because the file was not read first`,
      because:
        'Nothing to change: the harness already refuses an edit to a path it ' +
        'has not read, which is why these were refused. A rule asking for it ' +
        'would describe behaviour that already complies.',
      ...(cost !== undefined && cost.written + cost.received > 0 ? { cost } : {}),
    };
  }

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
    // ── A CLAUDE.md line only if the budget allows one ────────────────────
    //
    // This used to be unconditional. `docs/artifacts.md` measures a prose rule
    // at +0.066 pts across 753 rules, documents CLAUDE.md degrading past ~500
    // words with the correlation going negative past 1,000, and says the most
    // valuable memory action is often **removal**. A coach that appends on
    // every run is the mechanism of catastrophic remembering.
    ...(memoryAllowed() ? { memory: artifact.memory } : {}),
    because: `${reasonLabel(reason)} is the most common reason, at ${n} of ${target.occurrences}.`,
    ...(cost !== undefined && cost.written + cost.received > 0 ? { cost } : {}),
  };
}

/**
 * Is there room in `CLAUDE.md` for another line?
 *
 * Measured ceilings from `docs/artifacts.md`: well-performing files average
 * 300-350 words, past 500 shows diminishing returns, and past 1,000 the
 * correlation with performance goes **negative**. So this refuses rather than
 * appending to a file where the next line makes things worse.
 *
 * Absent or unreadable counts as room — the common case is a project with no
 * `CLAUDE.md` at all, and refusing there would be wrong.
 */
export const MEMORY_WORD_BUDGET = 500;

export function memoryAllowed(cwd: string = process.cwd()): boolean {
  try {
    const words = readFileSync(join(cwd, 'CLAUDE.md'), 'utf8').split(/\s+/).filter(Boolean).length;
    return words < MEMORY_WORD_BUDGET;
  } catch {
    return true;
  }
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

  // ── The mechanism first, because it is the only kind that measurably works ─
  //
  // Decided with the user: lead with GUARD/VERIFY/CONFIG where one exists, and
  // keep the prompt underneath as the low-commitment option. The snippet is
  // **printed and never written** — the never-touch-your-config rule is not
  // relaxed because the research likes hooks — and `costs` is shown with it
  // rather than as a footnote, because a Stop hook can refuse to end a turn.
  if (r.config !== undefined) {
    lines.push(`  ${cyan('▸')} ${dim(r.config.what)}`, '');
    for (const l of r.config.snippet.split('\n')) lines.push(`      ${l}`);
    lines.push('');
    for (const l of wrap(r.config.costs, 60)) lines.push(`      ${dim(l)}`);
    lines.push('', `      ${dim('nothing is written — this is yours to apply.')}`, '');
  }
  if (r.external !== undefined) {
    lines.push(`  ${cyan('▸')} ${dim('the industry already solved this one')}`, '');
    for (const l of wrap(r.external.what, 60)) lines.push(`      ${l}`);
    lines.push('', `      ${dim(r.external.where)}`, '');
  }
  if (r.prompt !== undefined) {
    const label =
      r.config === undefined
        ? 'for this session — paste or adopt'
        : 'or just for this session, if you would rather not configure anything';
    lines.push(`  ${cyan('▸')} ${dim(label)}`, '');
    for (const l of wrap(r.prompt, 60)) lines.push(`      ${l}`);
    lines.push('');
  }
  if (r.memory !== undefined) {
    lines.push(`  ${cyan('▸')} ${dim('to make it stick, add to CLAUDE.md')}`, '');
    lines.push(`      ${r.memory}`, '');
  } else if (r.prompt !== undefined && !memoryAllowed()) {
    // Say why there is no rule, rather than silently omitting it.
    for (const l of wrap(
      `Not suggesting a CLAUDE.md line — yours is already over ${MEMORY_WORD_BUDGET} words. ` +
        'Past that, extra rules tend to get skipped, and the file itself takes up room ' +
        'the agent could use for your actual work. Removing a stale rule helps more than ' +
        'adding another.',
      60,
    )) {
      lines.push(`      ${dim(l)}`);
    }
    lines.push('');
  }
  if (r.kind === 'REPORT') {
    // A REPORT is an answer, not an apology — so it states the conclusion
    // rather than drawing attention to the absence of a tip.
    for (const l of wrap(r.because, 60)) lines.push(`      ${l}`);
    lines.push('');
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
