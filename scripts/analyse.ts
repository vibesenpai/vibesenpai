/**
 * The detached analyser. Runs detectors and puts findings on the queue.
 *
 * Spawned by the `Stop` hook with `detached: true` and never waited on, so this
 * can take as long as it takes without costing anyone typing latency. Measured:
 * parse is 95% of the cost and ~420ms for 20 MB, which is far too much to spend
 * inside a hook's budget.
 *
 * Harness-agnostic by design: the transcript path, session id and archive all
 * arrive as arguments or env, never from Claude-specific assumptions. That is
 * what makes a second harness a manifest rather than a rewrite.
 *
 * Principle Zero: exits 0 unconditionally. A failure is recorded in the circuit
 * breaker so `doctor` can report it and the hook can stop spawning — degrading
 * to silence rather than to noise.
 */

import { readFileSync } from 'node:fs';
import { parse } from '../src/parsers/index.ts';
import { runDetectors, detectorsFor } from '../src/detect/index.ts';
import { resolveConfig } from '../src/config.ts';
import { enqueue, readQueue, writeQueue } from '../src/queue.ts';
import { recordFailure, recordSuccess } from '../src/breaker.ts';

async function main(): Promise<void> {
  const [transcript, sessionId] = process.argv.slice(2);
  if (transcript === undefined || sessionId === undefined) return;

  const { config } = resolveConfig();
  try {
    const parsed = parse(transcript, readFileSync(transcript, 'utf8'), sessionId);
    if (parsed.events.length === 0) {
      recordSuccess(config.archive);
      return;
    }

    const res = await runDetectors({
      events: parsed.events,
      session: { sessionId, project: projectOf(transcript), live: true },
      detectors: detectorsFor(config.preset, undefined, config.mute),
    });

    // Only `certain` and `high` reach the ambient surface. Anything less is a
    // guess, and a guess in a status bar is the false flag that costs trust
    // permanently — the one thing precision-over-recall exists to prevent.
    const surfaceable = res.findings.filter(
      (f) => f.confidence === 'certain' || f.confidence === 'high',
    );

    const q = readQueue(config.archive);
    writeQueue(config.archive, enqueue(q, sessionId, surfaceable));
    recordSuccess(config.archive);
  } catch (err) {
    recordFailure(config.archive, err instanceof Error ? err.message : 'analysis failed');
  }
}

function projectOf(source: string): string {
  const parts = source.split(/[\\/]/).filter((p) => p !== '');
  return parts.at(-2) ?? 'unknown';
}

try {
  await main();
} catch {
  // Already handled inside; this is the last line of defence.
}
process.exit(0);
