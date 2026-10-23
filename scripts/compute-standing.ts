/**
 * The detached standing pass. Parses every transcript it can find and writes
 * the aggregate for the statusline to pick up later.
 *
 * Spawned by `SessionStart` and never waited on. It is the slow side of the
 * handoff: parsing is 95% of the cost and scales with history, which is exactly
 * why no hook may do it.
 *
 * Principle Zero: exits 0 unconditionally. A session that cannot be read is
 * counted rather than skipped silently, and a total failure is recorded in the
 * circuit breaker so `doctor` can say so.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parse } from '../src/parsers/index.ts';
import { detectorsFor } from '../src/detect/index.ts';
import { resolveConfig } from '../src/config.ts';
import {
  clearStarted, computeStanding, isFresh, readStanding, writeStanding, type SessionInput,
} from '../src/standing.ts';
import { recordFailure, recordSuccess } from '../src/breaker.ts';
import { openStore, putOccurrences, transact, type Db } from '../src/store.ts';
// One enumeration, shared with `report`. This file used to shell out to `find`.
import { discoverTranscripts } from '../src/read.ts';

async function main(): Promise<void> {
  const { config } = resolveConfig();

  // Opening several windows at once must not parse the whole history several
  // times. `--force` is for the CLI, where somebody asked for it explicitly.
  const force = process.argv.includes('--force');
  if (!force && isFresh(readStanding(config.archive))) {
    clearStarted(config.archive);
    return;
  }

  try {
    const sessions: SessionInput[] = [];
    let unreadable = 0;
    for (const f of discoverTranscripts(config.sources)) {
      try {
        const id = basename(f, '.jsonl');
        const parsed = parse(f, readFileSync(f, 'utf8'), id);
        if (parsed.events.length === 0) continue;
        sessions.push({ sessionId: id, project: projectOf(f), events: parsed.events });
      } catch {
        unreadable++;
      }
    }

    const { standing, occurrences } = await computeStanding(
      sessions,
      detectorsFor(config.preset, undefined, config.mute),
      { unreadable },
    );
    writeStanding(config.archive, standing);

    // ── Persist the rule tier ───────────────────────────────────────────────
    //
    // Rule findings were never stored: this pass re-derived every one of them
    // from scratch each time, and wrote only a rollup that keeps one subject
    // per dimension. One transaction, upserted by content hash, so running
    // twice is a no-op and a crash leaves nothing half-written.
    if (occurrences.length > 0) {
      let db: Db | undefined;
      try {
        db = openStore(config.archive);
        transact(db, () => putOccurrences(db as Db, occurrences));
      } catch {
        // Principle Zero: a store that will not open must not fail the pass.
        // The rollup is already written, so the session still gets a report.
      } finally {
        db?.close();
      }
    }
    recordSuccess(config.archive);
  } catch (err) {
    recordFailure(config.archive, err instanceof Error ? err.message : 'standing pass failed');
  } finally {
    // Cleared either way: a marker left behind would keep the statusline saying
    // "reading your past sessions" over a pass that is no longer running.
    clearStarted(config.archive);
  }
}

function projectOf(source: string): string {
  const parts = source.split(/[\\/]/).filter((p) => p !== '');
  return parts.at(-2) ?? 'unknown';
}

try {
  await main();
} catch {
  // Last line of defence.
}
process.exit(0);
