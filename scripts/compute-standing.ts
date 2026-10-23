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
import {
  openStore, putOccurrences, putSessionCost, transact, type Db,
} from '../src/store.ts';
import { parseTranscript, withFullText } from '../src/parsers/claude-code.ts';
import { buildSession, estimateTokens, renderExtract } from '../src/judge.ts';
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
    const costs: { id: string; project: string; sizeBytes: number; packetTokens: number }[] = [];
    let unreadable = 0;
    for (const f of discoverTranscripts(config.sources)) {
      try {
        const id = basename(f, '.jsonl');
        const text = readFileSync(f, 'utf8');
        const parsed = parse(f, text, id);
        if (parsed.events.length === 0) continue;
        const project = projectOf(f);
        sessions.push({ sessionId: id, project, events: parsed.events });

        // ── Measure what the judge will have to read ──────────────────────
        //
        // Nothing cheap predicts it. Across 29 real sessions, tokens per KB
        // spans 1.5 to 9.4, and tokens against event count is not monotonic:
        // 6,067 events render to 66,196 tokens while 7,013 render to 55,691,
        // because consecutive same-role turns merge.
        //
        // This pass already parses every transcript, so building the packet
        // too costs +195ms on 1,442ms and no model tokens at all. The paid
        // pass then needs no estimate, and neither does the surface that says
        // how long the queue will take.
        try {
          const r = withFullText(() =>
            parseTranscript(text.split('\n'), id),
          );
          const events = [...r.result.events].sort((a, b) => a.seq - b.seq);
          const packet = buildSession(id, events, r.fullText, undefined);
          if (packet.packet.turns.length > 0) {
            costs.push({
              id,
              project,
              sizeBytes: Buffer.byteLength(text),
              packetTokens: estimateTokens(renderExtract([packet])),
            });
          }
        } catch {
          // A cost we cannot measure is one the estimate does without.
        }
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
    if (costs.length > 0) {
      let db: Db | undefined;
      try {
        db = openStore(config.archive);
        transact(db, () => putSessionCost(db as Db, costs));
      } catch {
        // Principle Zero: the rollup is already written.
      } finally {
        db?.close();
      }
    }

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
