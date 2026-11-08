/**
 * The `SessionStart` hook: prints the report as `systemMessage`, then heals and refreshes the free jobs.
 * `systemMessage` reaches the user, never the model; never emit `additionalContext` (CLAUDE.md Principle One).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from '../src/files.ts';
import { jobsHealth, superviseAll } from '../src/jobs.ts';
import {
  hasDisclosed, markDisclosed, readJudgeState, tallyByDimension,
} from '../src/judge/state.ts';
import { resolveConfig } from '../src/config.ts';
import { readStanding } from '../src/standing.ts';
import { disclosure, nextRung, reportBlock } from '../src/session-block.ts';

function main(): void {
  if (process.env['VIBESENPAI_DISABLE'] === '1') return;

  const { config } = resolveConfig();

  // Report before the breaker check, so a tripped analyser still shows stale results.
  const state = readJudgeState(config.archive);
  const fresh = newSinceLastSession(config.archive, state.findings.map((f) => f.at));
  const block = reportBlock(
    readStanding(config.archive),
    nextRung('block'),
    tallyByDimension(state),
    state.dismissed ?? 0,
    jobsHealth(config.archive),
    fresh,
  );

  // One-time disclosure, prepended so it is one message. Only this hook can say it:
  // the `Stop` hook that spends prints nothing.
  const notice = state.settings.enabled && !hasDisclosed(config.archive) ? disclosure(state.settings) : '';
  if (notice !== '') markDisclosed(config.archive);

  const message = `${notice}${block}`;
  if (message !== '') process.stdout.write(JSON.stringify({ systemMessage: message }));

  // Never the judge from here: only the Stop hook spends.
  superviseAll(config, { judge: false });
}

/** How many of `ats` are newer than the previous session's start, recording this one. */
function newSinceLastSession(archive: string, ats: string[]): number {
  const path = join(archive, 'last-session-start');
  let last: string | undefined;
  try {
    last = readFileSync(path, 'utf8').trim();
  } catch {
    // First session: nothing is "new" yet.
  }
  try {
    writeAtomic(path, new Date().toISOString());
  } catch {
    // Not worth failing a session over.
  }
  return last === undefined ? 0 : ats.filter((at) => at > last).length;
}

try {
  main();
} catch {
  // Silent: plain stdout would reach the model's context. Hooks exit 0.
}
process.exit(0);
