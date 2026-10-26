#!/usr/bin/env node
/**
 * The detached judge pass: spawned by the Stop hook, never awaited. Always exits 0, trips the breaker
 * on repeated failure. Child isolation lives in `src/judge/model.ts`; rules in .claude/rules/judge.md.
 */

import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { recordFailure, recordSuccess, isTripped, readBreaker } from '../src/breaker.ts';
import { resolveConfig } from '../src/config.ts';
import { discoverTranscripts } from '../src/read.ts';

import { readJudgeState, recordPass } from '../src/judge/state.ts';
import { clearJudgeRunning, judgeLockOwner, touchJudgeLock } from '../src/judge/lock.ts';
import { packBatches, planRound, runBatch } from '../src/judge/run.ts';


/** Far beyond any real backlog; rounds are bounded by the snapshot, so only a bug could reach this. */
const MAX_ROUNDS = 500;

/**
 * Drain everything pending: plan a round, send its batches at once, repeat.
 * Stops on the first failing round (one breaker fault) or a round that moves nothing.
 */
async function main(): Promise<void> {
  if (process.env['AGENTSENSEI_DISABLE'] === '1') return;

  const { config } = resolveConfig();
  const only = process.argv[2];
  let last = '';

  // Sizes as of the start of this pass; a live session would otherwise give new bytes every round.
  const snapshot = new Map<string, { source: string; size: number }>();
  for (const source of discoverTranscripts(config.sources)) {
    try {
      snapshot.set(basename(source, '.jsonl'), { source, size: statSync(source).size });
    } catch {
      // Vanished between listing and stat: not part of this pass.
    }
  }

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    touchJudgeLock(config.archive);
    // Dismissed findings included, so the model is not invited to report them again.
    const state = readJudgeState(config.archive, { dismissed: 'include' });
    if (!state.settings.enabled) return;
    if (isTripped(readBreaker(config.archive))) return;

    // No change in ledger or part cursors since last round means another round would repeat it.
    const progress = JSON.stringify([state.ledger, state.parts ?? {}]);
    if (progress === last) return;
    last = progress;

    const { batches, quiet } = packBatches(
      config.archive,
      planRound(config, state, only, snapshot),
      state.settings.maxBatchTokens,
      Math.max(1, state.settings.concurrency),
    );
    // Nothing was sent for these, so only the watermark moves.
    if (quiet.offsets.size > 0 || quiet.parts.size > 0) {
      recordPass(config.archive, [], quiet.offsets, quiet.parts);
    }
    if (batches.length === 0) return;

    const failures = (await Promise.all(batches.map((b) => runBatch(config.archive, state, b)))).filter(
      (f): f is string => f !== undefined,
    );
    if (failures.length > 0) {
      recordFailure(config.archive, [...new Set(failures)].join('; '));
      return;
    }
    recordSuccess(config.archive);
  }
}

// The spawner takes the in-flight marker; release it in `finally` as the spawner's pid (`judgeLockOwner`).
// A heartbeat keeps it fresh while this process lives, since a drain outlives its staleness.
const heartbeat = (() => {
  try {
    const archive = resolveConfig().config.archive;
    return setInterval(() => touchJudgeLock(archive), 60_000);
  } catch {
    return undefined;
  }
})();
heartbeat?.unref();

main()
  .catch(() => {
    // Principle Zero: a broken analyzer must never break a session.
  })
  .finally(() => {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    try {
      clearJudgeRunning(resolveConfig().config.archive, judgeLockOwner());
    } catch {
      // Staleness covers it.
    }
  });
