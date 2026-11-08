/** `fix`: one recommendation, with its evidence. */

import { readFileSync } from 'node:fs';
import { findSessionSource } from '../read.ts';
import { readJudgeState } from '../judge/state.ts';
import { parseTranscript } from '../parsers/claude-code.ts';
import { readStanding } from '../standing.ts';
import { applyPlan, compactionsFor, recommend, renderFix } from '../fix.ts';
import { applyRequest, fixDisplay, projectKey } from '../harness/claude-code.ts';
import { type Argv, configFromFlags, sessionForFix } from './common.ts';
import { findingKey, findingPlan, fixesFor, KIND_WORDS, type FindingFix, type SharedFix } from '../finding-fix.ts';
import type { JudgedFinding } from '../judge/state.ts';
import { projectLabel } from '../read.ts';
import { bold, cyan, dim, rule } from '../style.ts';
import { plural, wrap } from '../format.ts';
import { nextRung } from '../session-block.ts';

/** Reads the stored standing rather than recomputing, so it agrees with the session-start report. */
export function cmdFix(a: Argv): number {
  const { config } = configFromFlags(a);
  const s = readStanding(config.archive);
  // Judge findings count too, not only the rule detectors.
  const judgeState = readJudgeState(config.archive);
  const judged = judgeState.findings;
  if (s === undefined && judged.length === 0) {
    console.log('no standing yet — run `standing --refresh`, or open a new session.');
    return 0;
  }
  // A compaction before a finding changes the fix: an instruction summarised away was not ignored.
  const compactions = compactionsFor(judged, (id) => {
    const src = findSessionSource(config.sources, id);
    if (src === undefined) return undefined;
    try {
      return [...parseTranscript(readFileSync(src, 'utf8').split('\n'), id).events];
    } catch {
      return undefined;
    }
  });
  // A fix built from the findings themselves outranks the dimension's: shared first, then this project's newest.
  const own = pickFindingFix(judged, fixesFor(judged, (id) => sessionForFix(config.sources, id)), projectKey(process.cwd()));
  if (own !== undefined) {
    const here = own.shared?.projects.includes(own.fix.project) === true ? own.shared.projects : [own.fix.project];
    const plan = here.includes(projectKey(process.cwd())) ? findingPlan(own.fix) : undefined;
    if (a.flags['apply'] === true) {
      console.log(plan === undefined ? applyRefusal(own.fix, here) : `Apply this fix:\n\n${applyRequest([plan])}`);
      return 0;
    }
    console.log(renderFindingFix(own.fix, own.finding, own.shared));
    console.log(plan !== undefined ? `  To apply it: /agentsensei:apply\n` : `  ${dim(applyRefusal(own.fix, here))}\n`);
    return 0;
  }
  const r = recommend(s, judged, compactions);
  const plan = r === undefined ? undefined : applyPlan(r);
  // `/agentsensei:apply`: the developer typed it, so it is the yes; the marker in this output dates the fix.
  if (a.flags['apply'] === true) {
    console.log(plan === undefined ? 'nothing to apply: this recommendation has no change to make.' : `Apply this fix:\n\n${applyRequest([plan])}`);
    return 0;
  }
  console.log(renderFix(r, config.preset, config.mute, (s?.dismissed ?? 0) + (judgeState.dismissed ?? 0)));
  if (plan !== undefined) console.log(`  To apply it: /agentsensei:apply\n`);
  return 0;
}

/** The fix `fix` shows: the shared one with the most sessions, else the newest finding's, this project's first. */
function pickFindingFix(
  judged: JudgedFinding[],
  fixes: { byFinding: Map<string, FindingFix>; shared: SharedFix[] },
  project: string,
): { fix: FindingFix; finding?: JudgedFinding; shared?: SharedFix } | undefined {
  const top = fixes.shared[0];
  if (top !== undefined) return { fix: top.fix, shared: top };
  // Judged findings arrive newest first.
  const withFix = judged.filter((f) => fixes.byFinding.has(findingKey(f)));
  const f = withFix.find((x) => fixes.byFinding.get(findingKey(x))?.project === project) ?? withFix[0];
  return f === undefined ? undefined : { fix: fixes.byFinding.get(findingKey(f)) as FindingFix, finding: f };
}

/** Why there is nothing to apply here: a printed-only hook, or a fix for another project. */
function applyRefusal(x: FindingFix, projects: string[]): string {
  return !x.applicable
    ? 'Printed only: a Stop hook can hold a turn open up to 8 times in a row.'
    : `This happened in ${projects.map(projectLabel).join(' and ')}. Apply it from a session there.`;
}

/** A finding's fix, rendered: what happened first, then the change. */
function renderFindingFix(x: FindingFix, f: JudgedFinding | undefined, shared: SharedFix | undefined): string {
  const { destination, body } = fixDisplay(x);
  // The question theme spans misreads and overreach, so it is named for what happened.
  const title = x.kind === 'agent' ? 'questions answered with edits' : x.dimension.replace(/_/g, ' ');
  const lines = ['', `  ${bold(title.toUpperCase())}`, `  ${rule(68)}`, '', `  ${dim('What happened')}`];
  const happened =
    shared !== undefined
      ? `${plural(shared.findings, 'finding')} in ${plural(shared.sessions, 'session')}${x.kind === 'agent' ? ', each a question answered with an edit' : ''}.`
      : `${f?.why ?? ''} (session ${x.sessionId.slice(0, 8)}, turn${x.turns.length === 1 ? '' : 's'} ${x.turns.join(', ')})`;
  for (const l of wrap(happened, 62)) lines.push(`    ${l}`);
  if (x.source.quote !== '' && shared === undefined) {
    lines.push('');
    for (const l of wrap(`"${x.source.quote}"`, 60)) lines.push(`      ${dim(l)}`);
  }
  lines.push('', `  ${dim('What you can do')}`, '', `    ${cyan(KIND_WORDS[x.kind])}`, '');
  if (x.kind === 'check') lines.push(`      ${x.source.from ?? 'The project instructions'} already says this, and it was broken anyway:`, '');
  for (const l of body.split('\n')) lines.push(`      ${l}`);
  lines.push('');
  const where = x.kind === 'check' ? 'The agent shows you the test before adding it.' : `Added to ${destination}${x.paths === undefined ? '' : `, for ${x.paths.join(', ')}`}`;
  if (x.applicable) lines.push(`      ${dim(where)}`, '');
  lines.push(`  ${rule(68)}`, `  ${dim(nextRung('fix'))}`);
  return lines.join('\n');
}
