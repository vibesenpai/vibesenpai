/** `fix`: one recommendation, with its evidence. */

import { readFileSync } from 'node:fs';
import { findSessionSource } from '../read.ts';
import { readJudgeState } from '../judge/state.ts';
import { parseTranscript } from '../parsers/claude-code.ts';
import { readStanding } from '../standing.ts';
import { compactionsFor, recommend, renderFix } from '../fix.ts';
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
  console.log(
    renderFix(recommend(s, judged, compactions), config.preset, config.mute,
      (s?.dismissed ?? 0) + (judgeState.dismissed ?? 0)),
  );
  return 0;
}
