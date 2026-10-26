/**
 * The `SessionStart` hook: prints the report as `systemMessage`, then spawns a refresh and exits.
 * `systemMessage` reaches the user, never the model; never emit `additionalContext` (CLAUDE.md Principle One).
 */

import { runDetached } from '../src/spawn.ts';
import { isTripped, readBreaker } from '../src/breaker.ts';
import {
  hasDisclosed, markDisclosed, readJudgeState, tallyByDimension,
} from '../src/judge/state.ts';
import { resolveConfig } from '../src/config.ts';
import { isFresh, readStanding } from '../src/standing.ts';
import { nextRung, reportBlock } from '../src/session-block.ts';

/** Said once per machine: what it does, how to check its cost, and the off switch last. */
const DISCLOSURE = [
  '',
  'agentsensei is on — it reads your finished sessions in the background',
  'and shows where effort went to waste.',
  '',
  'It reads them with Claude on your own plan; /usage shows what it spent.',
  '',
  '  /agentsensei:insights   what it has found, here and across your history',
  '  /agentsensei:report     every session, as a file',
  '  /plugin disable agentsensei   stop it',
  '',
].join('\n');

function main(): void {
  if (process.env['AGENTSENSEI_DISABLE'] === '1') return;

  const { config } = resolveConfig();

  // Report before the breaker check, so a tripped analyser still shows stale results.
  const state = readJudgeState(config.archive);
  const block = reportBlock(
    readStanding(config.archive),
    nextRung('block'),
    tallyByDimension(state),
    state.dismissed ?? 0,
  );

  // One-time disclosure, prepended so it is one message. Only this hook can say it:
  // the `Stop` hook that spends prints nothing.
  const notice = state.settings.enabled && !hasDisclosed(config.archive) ? DISCLOSURE : '';
  if (notice !== '') markDisclosed(config.archive);

  const message = `${notice}${block}`;
  if (message !== '') process.stdout.write(JSON.stringify({ systemMessage: message }));

  if (isTripped(readBreaker(config.archive))) return;

  // Skip if the standing is recent, so several windows do not reparse history.
  if (isFresh(readStanding(config.archive))) return;

  runDetached('compute-standing.ts');
}

try {
  main();
} catch {
  // Silent: plain stdout would reach the model's context. Hooks exit 0.
}
process.exit(0);
