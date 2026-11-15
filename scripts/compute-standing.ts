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
import { clean, STANDING_DEADLINE_MS } from '../src/jobs.ts';
import { runJob, type Outcome } from '../src/supervise/index.ts';
import {
  openStore, putFixApplied, putOccurrences, putRuleFiles, putRuleLoaded, putSessionCost, transact,
  type Db, type FixSighting, type SessionCostRow,
} from '../src/store.ts';
import { rulesCounts, tallyLoaded, untilde } from '../src/rules.ts';
import { claudeDir } from '../src/config.ts';
import { knownRules } from '../src/fix.ts';
import { findingRules, fixesFor } from '../src/finding-fix.ts';
import { writeFindingFixes } from '../src/fix-file.ts';
import { sessionForFix } from '../src/cmd/common.ts';
import { readJudgeState } from '../src/judge/state.ts';
import { sightingsIn } from '../src/outcome.ts';
import { sessionCwd, withFullText, type Instruction } from '../src/parsers/claude-code.ts';
import { renderExtract } from '../src/judge/prompt.ts';
import { buildSession, estimateTokens } from '../src/judge/packet.ts';
import { discoverTranscripts, projectOf } from '../src/read.ts';
import { readDismissed } from '../src/dismiss.ts';
import { spanOf } from '../src/render.ts';

async function main(): Promise<Outcome> {
  const { config } = resolveConfig();

  // Skip if fresh, so several windows do not reparse history; `--force` overrides.
  const force = process.argv.includes('--force');
  if (!force && isFresh(readStanding(config.archive))) return { status: 'ok' };

  {
    const sessions: SessionInput[] = [];
    const costs: SessionCostRow[] = [];
    const applied: FixSighting[] = [];
    const loaded: FixSighting[] = [];
    // A finding's own rules too; an unreadable judge store just means only ours are looked for.
    const rules = [...knownRules(), ...(() => {
      try {
        return findingRules(readJudgeState(config.archive).findings);
      } catch {
        return [];
      }
    })()];
    // Per project: what each session loaded, and the folder the latest one started in. Paths only (D71).
    const ruleSources = new Map<string, { cwd?: string; cwdAt: string; sessions: { at: string; instructions: Instruction[] }[] }>();
    let unreadable = 0;
    for (const f of discoverTranscripts(config.sources)) {
      try {
        const id = basename(f, '.jsonl');
        const text = readFileSync(f, 'utf8');
        // One parse serves both the detectors and the judge's packet size.
        const { result: parsed, fullText, instructions } = withFullText(() => parse(f, text, id));
        if (parsed.events.length === 0) continue;
        const project = projectOf(f);
        sessions.push({ sessionId: id, project, events: parsed.events });
        // Ids and hashes of our own rule text only; the loaded instructions are never stored.
        const seen = sightingsIn(id, project, parsed.events, instructions, rules);
        applied.push(...seen.applied);
        loaded.push(...seen.loaded);

        const at = spanOf(parsed.events).first ?? '';
        // A subagent's transcript sits in a `subagents` folder; it is not a project of its own.
        if (!f.includes('/subagents/')) {
          const src = ruleSources.get(project) ?? { cwdAt: '', sessions: [] };
          src.sessions.push({ at, instructions });
          const cwd = at >= src.cwdAt ? sessionCwd(text.split('\n')) : undefined;
          if (cwd !== undefined) {
            src.cwd = untilde(cwd);
            src.cwdAt = at;
          }
          ruleSources.set(project, src);
        }

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
    // Rules per project: counts for the session-start line, and the loaded files' paths for the pane.
    const ruleFiles = new Map<string, ReturnType<typeof tallyLoaded>>();
    const ruleCounts: Record<string, { notLoaded: number; checks: number }> = {};
    for (const [project, src] of ruleSources) {
      try {
        const files = tallyLoaded(src.sessions);
        ruleFiles.set(project, files);
        if (src.cwd !== undefined) ruleCounts[project] = rulesCounts(src.cwd, claudeDir(), files);
      } catch {
        // Principle Zero: a project whose rules cannot be read is left out.
      }
    }
    writeStanding(config.archive, { ...standing, rules: ruleCounts });

    if (ruleFiles.size > 0) {
      let db: Db | undefined;
      try {
        db = openStore(config.archive);
        transact(db, () => {
          for (const [project, files] of ruleFiles) putRuleFiles(db as Db, project, ruleSources.get(project)?.cwd, files);
        });
      } catch {
        // Principle Zero: the Rules tab shows what it can.
      } finally {
        db?.close();
      }
    }

    // Each judged finding's own fix, for the pane. Reads only the judged sessions again.
    if (!process.argv.includes('--skip-fixes')) try {
      const judged = readJudgeState(config.archive).findings;
      writeFindingFixes(config.archive, fixesFor(judged, (id) => sessionForFix(config.sources, id)));
    } catch {
      // Principle Zero: the pane falls back to each dimension's fix.
    }

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

    if (applied.length + loaded.length > 0) {
      let db: Db | undefined;
      try {
        db = openStore(config.archive);
        transact(db, () => {
          putFixApplied(db as Db, applied);
          putRuleLoaded(db as Db, loaded);
        });
      } catch {
        // Principle Zero: an unrecorded fix is recorded on the next pass.
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
    return { status: 'ok' };
  }
}

try {
  const { archive } = resolveConfig().config;
  // Concurrent runs are safe (atomic writes, idempotent upserts), so a manual refresh never waits.
  await runJob('standing', archive, { deadlineMs: STANDING_DEADLINE_MS, allowConcurrent: true, clean }, main);
} catch {
  // Last line of defence.
}
process.exit(0);
