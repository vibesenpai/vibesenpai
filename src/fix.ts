/**
 * `fix`: picks at most one recommendation (the "something applicable" output) and renders it.
 * Nothing is applied here: `applyPlan` describes the change, and the agent makes it on the developer's
 * yes. Artifact kinds and their evidence: docs/artifacts.md.
 */

import { createHash } from 'node:crypto';
export { fixIdsIn, fixMarker } from './fix-marker.ts';
import type { Event } from './types.ts';
import type { Standing } from './standing.ts';
import type { JudgedFinding } from './judge/state.ts';
import { nextRung } from './session-block.ts';
import { reasonLabel } from './detect/labels.ts';
import { approx } from './cost.ts';
import { bold, cyan, dim, pad, rule } from './style.ts';
import { plural, wrap } from './format.ts';

/**
 * GUARD/VERIFY are deterministic hooks, CONFIG changes harness behaviour, PROMPT is model-judged,
 * MEMORY is a CLAUDE.md line (weakest; never the default), REPORT means no artifact exists.
 */
type ArtifactKind =
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
  /** Text to hand the agent for this session. Absent on a `REPORT`. */
  prompt?: string;
  /** A standing instruction line, for the project's rules file. */
  rule?: string;
  /** What the artifact is for (a harness reason or a dimension): the fix's identity, not its wording. */
  key?: string;
  /** Hook or settings fragment for GUARD/VERIFY/CONFIG. Printed, never written. */
  config?: { what: string; snippet: string; costs: string; helps: string };
  /** An existing external pattern that solves this. */
  external?: { what: string; where: string };
  /** Why this remedy addresses this failure, shown next to the prompt. */
  promptHelps?: string;
  /** The judge's own account of this occurrence. */
  happened?: string;
  /** Why this recommendation, so it can be argued with. */
  because: string;
  /** Tokens this reason has already cost. Past cost, not a forecast. */
  cost?: { written: number; received: number };
};

/** Fix per harness reason (not per dimension). A reason absent here has no artifact. */
const ARTIFACTS: Record<string, { prompt: string; rule: string }> = {
  'not-read-first': {
    prompt:
      'For the rest of this session: read a file before editing it. ' +
      'Do not issue an Edit or Write against a path you have not read in this session.',
    rule: '- Read a file before editing it; never edit a path unread this session.',
  },
  'string-not-found': {
    prompt:
      'For the rest of this session: before editing, re-read the exact region you are about to ' +
      'change if anything may have altered it since you last read it — a linter, a formatter, ' +
      'another tool, or your own earlier edit.',
    rule: '- Re-read right before editing if anything may have changed the file.',
  },
  'stale-read': {
    prompt:
      'For the rest of this session: when an edit is refused as stale, re-read the file before ' +
      'retrying rather than reissuing the same edit.',
    rule: '- After a stale-read refusal, re-read before retrying the edit.',
  },
  'ambiguous-target': {
    prompt:
      'For the rest of this session: when replacing text that appears more than once, quote ' +
      'enough surrounding context to make the match unique rather than retrying the short form.',
    rule: '- Quote enough context to make an edit target unique.',
  },
};

/**
 * Dimensions with no artifact. Re-reads are cheap and often correct; `other` is unknown by
 * construction. Why each dimension gets its mechanism: docs/artifacts.md.
 */
const REPORT_ONLY = new Set(['redundant_call', 'other']);

/** A `Stop` hook is the one mechanism that sees every write surface. */
const STOP_HOOK_COSTS =
  'This can stop a turn from finishing and send the agent back to work. ' +
  'Claude Code will not let that repeat more than 8 times in a row.';

/**
 * Compactions before the cited turn. A constraint said in chat can be compacted away while hooks
 * and files survive, so a compaction changes the fix (arXiv 2606.22528).
 */
type CompactionContext = {
  /** Compactions strictly before the cited turn. */
  before: number;
  /** Tokens the last one discarded (preTokens - postTokens). */
  dropped: number;
};

/** Per session id. Computed by the caller so `recommend` stays pure. */
export type Compactions = Map<string, CompactionContext>;

type DimensionFix = {
  kind: ArtifactKind;
  prompt?: string;
  rule?: string;
  config?: { what: string; snippet: string; costs: string; helps: string };
  external?: { what: string; where: string };
  promptHelps?: string;
  because: string;
};

const BY_DIMENSION: Record<string, DimensionFix> = {
  constraint_violation: {
    kind: 'VERIFY',
    config: {
      helps:
        'Claude Code runs the check itself when the turn ends, so a constraint ' +
        'holds whether or not the model still remembers it.',
      what: 'a Stop hook that checks the diff before the turn can end',
      snippet: `{ "hooks": { "Stop": [{ "hooks": [{ "type": "command",
    "command": "git diff --name-only | grep -qE '<paths you said not to touch>' && { echo 'touched a path you asked me not to' >&2; exit 2; } || true" }] }] } }`,
      costs: STOP_HOOK_COSTS,
    },
    prompt:
      'For the rest of this session, before any edit or command: check it ' +
      'against every constraint stated earlier in this conversation, and say ' +
      'which one you checked against.',
    rule: '- Before any edit or command, check it against every constraint stated earlier in the conversation, and name the one you checked.',
    promptHelps:
      'Naming the constraint out loud is what makes a slip visible to you ' +
      'while there is still time to stop it.',
    because:
      'A hook is checked by Claude Code itself, so it holds whether or not the ' +
      'model remembers. Asking in a prompt only works while it is paying ' +
      'attention.',
  },
  overreach: {
    kind: 'GUARD',
    config: {
      helps:
        'The list of changed files is checkable where "too much" is not, so ' +
        'this catches the scope creep the request itself cannot describe.',
      what: 'a Stop hook that holds the diff to what was asked',
      snippet: `{ "hooks": { "Stop": [{ "hooks": [{ "type": "command",
    "command": "git diff --name-only | grep -vqE '<paths this task should touch>' && { echo 'changed files outside the task' >&2; exit 2; } || true" }] }] } }`,
      costs: STOP_HOOK_COSTS,
    },
    prompt:
      'For the rest of this session: do only what was asked. If you think ' +
      'something adjacent needs doing, say so and wait rather than doing it.',
    rule: '- Do only what was asked. If something adjacent needs doing, say so and wait.',
    promptHelps:
      'Turns a silent extra change into a sentence you can say no to.',
    because:
      'Nothing can tell "too much" from "just enough" by reading the request — ' +
      'but the list of changed files is checkable. Blocking the tools is not ' +
      'enough on its own, because a shell command can write files too.',
  },
  inaccurate_self_report: {
    kind: 'VERIFY',
    config: {
      helps:
        'Running the command settles whether the tests pass; reading a summary ' +
        'of them does not. This makes the turn end on the outcome, not the claim.',
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
    rule: '- Never report work as done or passing unless a command in this session shows it; quote the output.',
    promptHelps:
      'A quoted command output is something you can check in a second; ' +
      '"tests pass" is something you have to take on trust.',
    because:
      'Whether the tests pass is not a matter of opinion, so it is worth ' +
      'checking rather than trusting. Running the command settles it; reading ' +
      'the summary does not.',
  },
  misread_intent: {
    kind: 'CONFIG',
    config: {
      helps:
        'Claude states its reading before it acts, so a wrong one costs you a ' +
        'sentence instead of a session.',
      what: 'plan mode, so the reading gets agreed before the work starts',
      snippet: 'shift+tab to cycle into plan mode, or `claude --permission-mode plan`',
      costs:
        'Slower, because you approve a plan before work starts. Worth it for ' +
        'anything ambiguous, and in the way for anything obvious.',
    },
    prompt:
      'For the rest of this session: before acting on anything ambiguous, ' +
      'state the reading you are acting on in one line and wait.',
    rule: '- Before acting on anything ambiguous, state the reading you are acting on in one line and wait.',
    promptHelps:
      'The same check as plan mode, without changing any settings — it just ' +
      'relies on the model remembering, where plan mode does not.',
    because:
      'Nothing can check whether it understood you — that is the one thing ' +
      'only you can confirm. Agreeing the plan first recovers almost ' +
      'everything a vague request costs.',
  },
};

/**
 * The one thing worth changing, or nothing.
 * Ranked by occurrences among dimensions that have an artifact, so a report-only one never wins.
 */
export function recommend(
  s: Standing | undefined,
  judged: JudgedFinding[] = [],
  compactions: Compactions = new Map(),
): Recommendation | undefined {
  // Judged dimensions with a mechanism in `BY_DIMENSION` outrank rule findings.
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
    // A compaction before the cited turn replaces the generic mechanism: the
    // constraint may no longer have been in view.
    const lost = anchors
      .map((f) => compactions.get(f.sessionId))
      .filter((c): c is CompactionContext => c !== undefined && c.before > 0)
      .sort((a, b) => b.dropped - a.dropped)[0];

    const overlay =
      lost !== undefined && (dimension === 'constraint_violation' || dimension === 'overreach')
        ? {
            because:
              'This one may not have been ignored. The conversation was ' +
              `compacted first, dropping about ${approx(lost.dropped)} tokens — ` +
              'so by the time of this turn the instruction may simply no longer ' +
              'have been in view. Anything you say in chat can be summarised ' +
              'away; a file on disk cannot.',
            config: {
              helps:
                'A compaction can summarise away anything said in chat. A file ' +
                'on disk survives it, and re-reading it puts the instruction ' +
                'back in view at the exact moment it was lost.',
              what: 'put standing instructions in a file, and re-read it after every compaction',
              snippet: `# once:  put them in .claude/standing.md
{ "hooks": { "SessionStart": [{ "matcher": "compact",
    "hooks": [{ "type": "command", "command": "cat .claude/standing.md" }] }] } }`,
              costs:
                'Costs you nothing per turn. The file is re-read only after a ' +
                'compaction, so it stays out of the way until the moment it is ' +
                'needed. Project CLAUDE.md is already re-read this way — this is ' +
                'for the instructions that are too long or too situational to live ' +
                'there.',
            },
          }
        : undefined;

    return {
      kind: overlay !== undefined ? 'CONFIG' : fix.kind,
      dimension,
      evidence:
        `${plural(n, 'time')} across your sessions, at ${where}` +
        (first.name !== undefined ? ` — ${first.name}` : '') +
        (first.quote !== undefined && first.quote !== '' ? `\n             "${first.quote.slice(0, QUOTE_MAX)}"` : ''),
      because: overlay?.because ?? fix.because,
      ...(first.why === undefined || first.why === '' ? {} : { happened: first.why }),
      key: dimension,
      ...(fix.prompt !== undefined ? { prompt: fix.prompt } : {}),
      ...(fix.rule !== undefined ? { rule: fix.rule } : {}),
      ...(fix.promptHelps !== undefined ? { promptHelps: fix.promptHelps } : {}),
      ...(overlay?.config !== undefined
        ? { config: overlay.config }
        : fix.config !== undefined
          ? { config: fix.config }
          : {}),
      ...(fix.external !== undefined ? { external: fix.external } : {}),
    };
  }

  // A judged REPORT is a candidate, not a last resort, so `other` descriptors get shown.
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
    // Prefer the judged report: it may carry descriptors.
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

  // The dominant reason with a useful artifact picks it; ties break by key so re-runs agree.
  // `not-read-first` is passed over while another reason has one: its rule would be ceremonial.
  const ranked = Object.entries(s.reasons).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top =
    ranked.find(([key]) => ARTIFACTS[key] !== undefined && key !== 'not-read-first') ??
    ranked.find(([key]) => key === 'not-read-first');

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

  // The harness already refuses unread edits, so a rule would be ceremonial
  // (docs/artifacts.md). Report instead.
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

  const artifact = ARTIFACTS[reason] as { prompt: string; rule: string };
  // `?.`: `readStanding` casts without validating, so older files lack this field.
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
    key: reason,
    prompt: artifact.prompt,
    rule: artifact.rule,
    because:
      reason === ranked[0]?.[0]
        ? `${reasonLabel(reason)} is the most common reason, at ${n} of ${target.occurrences}.`
        : `${reasonLabel(reason)} is the most common reason there is a fix for, at ${n} of ${target.occurrences}.`,
    ...(cost !== undefined && cost.written + cost.received > 0 ? { cost } : {}),
  };
}

/**
 * Compaction context for the sessions the findings came from, two numbers per session.
 * An unreadable transcript just means no overlay.
 */
export function compactionsFor(
  judged: JudgedFinding[],
  read: (sessionId: string) => Event[] | undefined,
): Compactions {
  const out: Compactions = new Map();
  for (const id of new Set(judged.map((f) => f.sessionId))) {
    const events = read(id);
    if (events === undefined) continue;
    const cited = Math.min(
      ...judged.filter((f) => f.sessionId === id).flatMap((f) => f.turns),
    );
    const before = events
      .filter((e) => e.compaction !== undefined && e.seq < cited)
      .sort((a, b) => a.seq - b.seq);
    const last = before[before.length - 1];
    if (last === undefined) continue;
    const c = last.compaction as { preTokens: number; postTokens: number };
    out.set(id, { before: before.length, dropped: Math.max(0, c.preTokens - c.postTokens) });
  }
  return out;
}

/** Quote length shown by `:fix`, matched to the HTML report. */
const QUOTE_MAX = 200;

/** Where a fix lands: harness-neutral. Each harness's adapter names the file. */
export type ApplyTarget =
  | 'session'
  | 'project-instructions'
  | 'project-hooks'
  | 'project-permissions'
  | 'scoped-instructions'
  | 'project-check'
  | 'project-agent';

export type ApplyPlan = {
  fixId: string;
  dimension: string;
  target: ApplyTarget;
  text: string;
  /** Project-relative files a scoped rule loads for. */
  paths?: string[];
  /** The words a check enforces were loaded from this file. */
  from?: string;
  /** A finding's own fix: what it is for (`action:git push`), so its outcome counts that constraint. */
  key?: string;
};

/**
 * The change one recommendation makes, or undefined when there is nothing to apply. A standing rule
 * beats a session prompt. Hooks get no plan until each snippet is bounded (plan: apply-fixes, step 5).
 */
export function applyPlan(r: Recommendation): ApplyPlan | undefined {
  const pick: [ApplyTarget, string] | undefined =
    r.rule !== undefined ? ['project-instructions', r.rule] : r.prompt !== undefined ? ['session', r.prompt] : undefined;
  if (pick === undefined) return undefined;
  const [target, text] = pick;
  return { fixId: fixIdOf(target, r.dimension, r.key ?? r.dimension), dimension: r.dimension, target, text };
}

/** The Stop hook that runs the check instead of trusting the claim; printed, never applied. */
export function stopHookSnippet(): string {
  return (BY_DIMENSION['inaccurate_self_report'] as DimensionFix).config?.snippet ?? '';
}

/** Every standing rule a fix can add, for spotting one loaded in a later session. */
export function knownRules(): string[] {
  return [...Object.values(ARTIFACTS).map((a) => a.rule), ...Object.values(BY_DIMENSION).flatMap((d) => (d.rule === undefined ? [] : [d.rule]))];
}

/** Six hex characters from what the fix is for, never its wording, so a reworded fix keeps its history. */
export function fixIdOf(target: ApplyTarget, dimension: string, key: string): string {
  return createHash('sha256').update(`${target}:${dimension}:${key}`).digest('hex').slice(0, 6);
}

/** The recommendation, rendered: evidence first, then what to do. */
export function renderFix(
  r: Recommendation | undefined,
  preset: string,
  muted: string[] = [],
  dismissed = 0,
): string {
  const lines: string[] = [];
  const W = 68;

  if (r === undefined) {
    lines.push(dim('nothing to recommend yet.'));
    // "No findings in your history" is false once someone has dismissed them.
    lines.push(
      dismissed > 0
        ? `  ${dim(`${dismissed} finding${dismissed === 1 ? ' is' : 's are'} dismissed; Restore all on the pane's Health tab brings them back.`)}`
        : `  ${dim('no findings in your history, or no standing computed — run `standing --refresh`.')}`,
    );
    return lines.join('\n');
  }

  lines.push(
    '',
    `  ${bold(r.dimension.replace(/_/g, ' ').toUpperCase())}`,
    `  ${rule(W)}`,
    '',
  );


  lines.push(`  ${dim('What happened')}`);
  for (const l of wrap(r.happened ?? r.evidence, 62)) lines.push(`    ${l}`);
  lines.push('');
  lines.push(`  ${dim('Why it happens')}`);
  for (const l of wrap(r.because, 62)) lines.push(`    ${l}`);
  lines.push('');
  if (r.cost !== undefined) {
    lines.push(
      `  ${pad('cost', 10, dim)} ${bold(`${approx(r.cost.written)} tokens`)} ${dim('written and discarded')}`,
    );
  }

  // Mechanism first, prompt as the fallback. The snippet is printed, never written.
  lines.push(`  ${dim('What you can do')}`, '');
  if (r.config !== undefined) {
    lines.push(`    ${cyan(r.config.what)}`, '');
    for (const l of wrap(r.config.helps, 60)) lines.push(`      ${l}`);
    lines.push('');
    for (const l of r.config.snippet.split('\n')) lines.push(`      ${l}`);
    lines.push('');
    for (const l of wrap(r.config.costs, 60)) lines.push(`      ${dim(l)}`);
    lines.push('', `      ${dim('nothing is written — this is yours to apply.')}`, '');
  }
  if (r.external !== undefined) {
    lines.push(`    ${cyan('the industry already solved this one')}`, '');
    for (const l of wrap(r.external.what, 60)) lines.push(`      ${l}`);
    lines.push('', `      ${dim(r.external.where)}`, '');
  }
  if (r.prompt !== undefined) {
    const label =
      r.config === undefined
        ? 'for this session — paste or adopt'
        : 'or just for this session, if you would rather not configure anything';
    lines.push(`    ${cyan(label)}`, '');
    for (const l of wrap(r.prompt, 60)) lines.push(`      ${l}`);
    lines.push('');
    if (r.promptHelps !== undefined) {
      for (const l of wrap(r.promptHelps, 60)) lines.push(`      ${dim(l)}`);
      lines.push('');
    }
  }
  if (r.rule !== undefined) {
    lines.push(`    ${cyan('to make it stick, a standing rule')}`, '');
    lines.push(`      ${r.rule}`, '');
  }
  if (r.kind === 'REPORT') {
    for (const l of wrap(r.because, 60)) lines.push(`      ${l}`);
    lines.push('');
  }

  // Adopting a brief changes the session being measured.
  if (r.prompt !== undefined) {
    for (const l of wrap(
      'adopting this changes the session it is measuring, so this dimension will read as suppressed rather than improved until you drop it again.',
      62,
    )) {
      lines.push(`  ${dim(l)}`);
    }
    lines.push('');
  }

  lines.push(
    `  ${rule(W)}`,
    `  ${dim(`chosen from preset "${preset}"${muted.length > 0 ? ` · muted: ${muted.join(', ')}` : ''}`)}`,
    '',
    `  ${dim(nextRung('fix'))}`,
  );
  return lines.join('\n');
}
