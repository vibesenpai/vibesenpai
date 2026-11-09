/** `insights`: the session you are in, then your history, then what is left to read. */

import { statSync } from 'node:fs';
import { bold, dim } from '../style.ts';
import { type Config } from '../config.ts';
import { parse } from '../parsers/index.ts';
import { projectOf, readSession, resolveCurrentSession, sessionSizes } from '../read.ts';
import { findingsFor, readJudgeState, tallyByDimension, type JudgeState } from '../judge/state.ts';
import { analysisBlock, pendingWork } from '../judge/schedule.ts';
import { JUDGE_STALE_MS, jobsHealth } from '../jobs.ts';
import { runDetectors } from '../detect/index.ts';
import { render as renderFindings } from '../render.ts';
import { currentRun, measuredCallMs, measuredMsPerToken, openStore, sessionCosts } from '../store.ts';
import { readDismissed, withoutDismissed } from '../dismiss.ts';
import { readStanding } from '../standing.ts';
import { cacheLine, dimensionLine, whereLine } from '../session-block.ts';
import { plural } from '../format.ts';
import { type Argv, configFromFlags, detectorsFromConfig, printSkeletons } from './common.ts';

/** As many dimensions as the history block shows before it summarises. */
const HISTORY_DIMENSIONS = 3;

/** Your history, on demand (otherwise only shown at session start). */
function printHistory(config: Config, judgeState: JudgeState): void {
  const standing = readStanding(config.archive);
  if (standing === undefined) {
    console.log('');
    console.log(`  ${dim('Your history has not been read yet. It runs in the background after a turn ends.')}`);
    return;
  }

  console.log('');
  console.log(`  ${bold('Your history')}`);
  console.log('');

  const judged = tallyByDimension(judgeState);
  const dismissed = (standing.dismissed ?? 0) + (judgeState.dismissed ?? 0);
  if (standing.dimensions.length === 0 && judged.length === 0) {
    // After a dismissal, "nothing found yet" would be false.
    console.log(`    ${dim(dismissed > 0 ? 'Nothing to show.' : 'Nothing found yet.')}`);
  } else {
    // Capped like `reportBlock`.
    for (const d of standing.dimensions.slice(0, HISTORY_DIMENSIONS)) {
      console.log(`    ${dimensionLine(d)}`);
      // `whereLine` carries its own indent.
      const where = whereLine(d);
      if (where !== '') console.log(`  ${where}`);
    }
    const hidden = standing.dimensions.length - HISTORY_DIMENSIONS;
    if (hidden > 0) console.log(`    ${dim(`and ${hidden} more`)}`);

    for (const { dimension, count } of judged) {
      // No "by a model" marker in this rollup; it stays on session findings, beside their turns.
      console.log(`    ${count} ${dimension.replace(/_/g, ' ')}`);
    }
  }

  // Said, so shrunken totals don't read as the problem going away.
  if (dismissed > 0) {
    console.log(`    ${dim(`${plural(dismissed, 'finding')} dismissed, not shown`)}`);
  }

  const cost = cacheLine(standing);
  if (cost !== '') {
    console.log('');
    console.log(`  ${dim(cost)}`);
  }

  printAnalysis(config, judgeState);
}

/** Progress and what remains, from the store rather than from the standing. */
function printAnalysis(config: Config, state: JudgeState): void {
  let lines: string[] = [];
  try {
    const db = openStore(config.archive);
    try {
      const sizes = sessionSizes(config.sources);
      const { unread, judged, behind } = pendingWork(state, sizes);

      // Queue size in tokens, measured by the standing pass; absent until it has run.
      const costs = sessionCosts(db);
      const queueTokens = sizes
        .filter((x) => (state.ledger[x.id] ?? 0) === 0 && costs.has(x.id))
        .reduce((n, x) => n + (costs.get(x.id) ?? 0), 0);

      lines = analysisBlock({
        total: sizes.length,
        ...(queueTokens > 0 ? { queueTokens } : {}),
        budget: state.settings.maxBatchTokens,
        concurrency: state.settings.concurrency,
        ...(() => {
          const r = measuredMsPerToken(db);
          return r === undefined ? {} : { msPerToken: r };
        })(),
        // "Read" means looked at at all; a live session is never fully caught up.
        read: judged + behind,
        unread,
        ...(() => {
          const run = currentRun(db, JUDGE_STALE_MS);
          return run === undefined ? {} : { running: run };
        })(),
        ...(() => {
          const ms = measuredCallMs(db);
          return ms === undefined ? {} : { callMs: ms };
        })(),
        ...(jobsHealth(config.archive).some((j) => j.job === 'judge' && j.state === 'running') ? { spawned: true } : {}),
      });
    } finally {
      db.close();
    }
  } catch {
    // A store that will not open is not a reason to withhold the history.
  }
  if (lines.length === 0) return;
  console.log('');
  console.log(`  ${bold('Analysis')}`);
  console.log('');
  for (const l of lines) console.log(`    ${dim(l)}`);
}

export async function cmdInsights(a: Argv): Promise<number> {
  const { config } = configFromFlags(a);
  const flagSession = a.flags['session'];
  const current = resolveCurrentSession(config.sources, {
    ...(typeof flagSession === 'string' ? { sessionId: flagSession } : {}),
  });

  if (current === undefined) {
    console.error(`no transcript found under: ${config.sources.join(', ')}`);
    return 1;
  }
  a.flags['live'] = true;

  // Live mode: `readSession` tails past the catalogued offset.
  const read = readSession({ source: current.source, sessionId: current.sessionId, mode: 'live' });
  const parsed = parse(current.source, read.text, current.sessionId);

  const detectors = detectorsFromConfig(config);
  const res = await runDetectors({
    events: parsed.events,
    session: { sessionId: current.sessionId, project: projectOf(current.source), live: true },
    detectors,
  });
  // Read live, so dismissals are filtered here, not by the standing pass.
  const shown = withoutDismissed(res.findings, readDismissed(config.archive)).findings;

  // Precomputed by the detached pass; this command never judges or spends.
  const judgeState = readJudgeState(config.archive);
  const judgedFindings = findingsFor(judgeState, current.sessionId);

  const judgedBytes = judgeState.ledger[current.sessionId] ?? 0;
  let unjudgedTurns = 0;
  try {
    const size = statSync(current.source).size;
    if (size > judgedBytes) {
      // Scaled to parsed events, not bytes ÷ a constant, so it can never exceed the session.
      const share = (size - judgedBytes) / size;
      unjudgedTurns = Math.min(parsed.events.length, Math.round(parsed.events.length * share));
    }
  } catch {
    // Unreadable size: the lag line is simply absent.
  }


  process.stdout.write(
    renderFindings({
      findings: shown,
      denominators: res.denominators,
      sessionId: current.sessionId,
      events: parsed.events,
      ...(judgeState.settings.enabled
        ? {
            judged: {
              findings: judgedFindings,
              unjudgedTurns,
            },
          }
        : {}),
      ...(config.mute.length > 0 ? { muted: config.mute } : {}),
    }),
  );

  for (const [dim, n] of Object.entries(res.failures)) {
    // Never swallowed: a silent zero would read as "nothing found".
    console.error(`warning: ${dim} failed ${n}x and reported nothing`);
  }
  if (detectors.length === 0) {
    console.error(
      `warning: preset "${config.preset}" selected no detectors — nothing could be found`,
    );
  }

  // Debug view; also available as `vibesenpai skeleton`.
  if (a.flags['skeleton'] === true) {
    return printSkeletons(a, current.sessionId, current.source, undefined, true);
  }
    printHistory(config, judgeState);

    // Next steps go last, as `Run X for Y` sentences like `nextRung`.
    const ways = [
      'Run /vibesenpai:report for more details',
    ];
    console.log('');
    for (const w of ways) console.log(`  ${dim(w)}`);
    console.log('');
  return 0;
}
