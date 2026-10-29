#!/usr/bin/env node
/**
 * The detached judge pass: started by the supervisor, never awaited. Always exits 0; `runJob` records how
 * it went, so the next hook can heal it. Child isolation lives in `src/judge/model.ts`; rules in .claude/rules/judge.md.
 */

import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { resolveConfig } from '../src/config.ts';
import { discoverTranscripts } from '../src/read.ts';

import { readJudgeState, recordPass } from '../src/judge/state.ts';
import { clean, JUDGE_DEADLINE_MS } from '../src/jobs.ts';
import { runJob, type Outcome } from '../src/supervise/index.ts';
import { packBatches, planRound, runBatch, type BatchFailure } from '../src/judge/run.ts';


/** Far beyond any real backlog; rounds are bounded by the snapshot, so only a bug could reach this. */
const MAX_ROUNDS = 500;

/**
 * Drain everything pending: plan a round, send its batches at once, repeat.
 * Stops on the first failing round (one failure for the supervisor) or a round that moves nothing.
 */
async function drain(holds: () => boolean): Promise<Outcome> {
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
    if (!holds()) return { status: 'ok' };
    // Dismissed findings included, so the model is not invited to report them again.
    const state = readJudgeState(config.archive, { dismissed: 'include' });
    if (!state.settings.enabled) return { status: 'ok' };

    // No change in ledger or part cursors since last round means another round would repeat it.
    const progress = JSON.stringify([state.ledger, state.parts ?? {}]);
    if (progress === last) return { status: 'ok' };
    last = progress;

    const { batches, quiet } = packBatches(
      config.archive,
      planRound(config, state, only, snapshot),
      state.settings.maxBatchTokens,
      Math.max(1, state.settings.concurrency),
    );
    // Nothing was sent for these, so only the watermark moves.
    if ((quiet.offsets.size > 0 || quiet.parts.size > 0) && holds()) {
      recordPass(config.archive, [], quiet.offsets, quiet.parts);
    }
    if (batches.length === 0) return { status: 'ok' };

    const failures = (await Promise.all(batches.map((b) => runBatch(config.archive, state, b, holds)))).filter(
      (f): f is BatchFailure => f !== undefined,
    );
    if (failures.length > 0) {
      const reason = clean([...new Set(failures.map((f) => f.reason))].join('; '));
      return { status: 'failed', kind: failures.some((f) => f.paid) ? 'paid' : 'free', reason };
    }
  }
  return { status: 'ok' };
}

if (process.env['AGENTSENSEI_DISABLE'] !== '1') {
  try {
    const { archive } = resolveConfig().config;
    await runJob('judge', archive, { deadlineMs: JUDGE_DEADLINE_MS, clean }, (ctx) => drain(ctx.holds));
  } catch {
    // Principle Zero: a broken analyzer must never break a session.
  }
}
process.exit(0);
