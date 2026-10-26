/**
 * Detached standing pass, spawned by the hooks and never waited on: parses every
 * transcript, writes the standing and stores rule findings and session costs. Exits 0.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parse } from '../src/parsers/index.ts';
import { detectorsFor } from '../src/detect/index.ts';
import { resolveConfig } from '../src/config.ts';
import {
  computeStanding, isFresh, readStanding, writeStanding, type SessionInput,
} from '../src/standing.ts';
import { recordFailure, recordSuccess } from '../src/breaker.ts';
import {
  openStore, putOccurrences, putSessionCost, transact, type Db, type SessionCostRow,
} from '../src/store.ts';
import { withFullText } from '../src/parsers/claude-code.ts';
import { renderExtract } from '../src/judge/prompt.ts';
import { buildSession, estimateTokens } from '../src/judge/packet.ts';
import { discoverTranscripts, projectOf } from '../src/read.ts';
import { readDismissed } from '../src/dismiss.ts';
import { spanOf } from '../src/render.ts';

async function main(): Promise<void> {
  const { config } = resolveConfig();

  // Skip if fresh, so several windows do not reparse history; `--force` overrides.
  const force = process.argv.includes('--force');
  if (!force && isFresh(readStanding(config.archive))) return;

  try {
    const sessions: SessionInput[] = [];
    const costs: SessionCostRow[] = [];
    let unreadable = 0;
    for (const f of discoverTranscripts(config.sources)) {
      try {
        const id = basename(f, '.jsonl');
        const text = readFileSync(f, 'utf8');
        // One parse serves both the detectors and the judge's packet size.
        const { result: parsed, fullText } = withFullText(() => parse(f, text, id));
        if (parsed.events.length === 0) continue;
        const project = projectOf(f);
        sessions.push({ sessionId: id, project, events: parsed.events });

        // What the judge will have to read, measured now so the queue needs no estimate.
        try {
          const events = [...parsed.events].sort((a, b) => a.seq - b.seq);
          const packet = buildSession(id, events, fullText, undefined);
          if (packet.packet.turns.length > 0) {
            // Stored because the row outlives the transcript (the harness deletes it after its TTL).
            const span = spanOf(events);
            costs.push({
              id,
              project,
              sizeBytes: Buffer.byteLength(text),
              packetTokens: estimateTokens(renderExtract([packet])),
              ...(span.first !== undefined ? { firstTs: span.first } : {}),
              ...(span.last !== undefined ? { lastTs: span.last } : {}),
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
      { unreadable, dismissed: readDismissed(config.archive) },
    );
    writeStanding(config.archive, standing);

    // One transaction each, upserted by content hash: rerunning is a no-op.
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
        // Principle Zero: the rollup is already written.
      } finally {
        db?.close();
      }
    }
    recordSuccess(config.archive);
  } catch (err) {
    recordFailure(config.archive, err instanceof Error ? err.message : 'standing pass failed');
  }
}


try {
  await main();
} catch {
  // Last line of defence.
}
process.exit(0);
