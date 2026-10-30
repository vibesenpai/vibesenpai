/** `fix`: one recommendation, with its evidence. */

import { readFileSync } from 'node:fs';
import { findSessionSource } from '../read.ts';
import { readJudgeState } from '../judge/state.ts';
import { parseTranscript } from '../parsers/claude-code.ts';
import { readStanding } from '../standing.ts';
import { applyPlan, compactionsFor, recommend, renderFix } from '../fix.ts';
import { applyRequest } from '../harness/claude-code.ts';
import { type Argv, configFromFlags } from './common.ts';

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
