#!/usr/bin/env node
/**
 * The detached judge pass.
 *
 * Spawned, never awaited — the same shape as `compute-standing.ts`, and for the
 * same reason: a hook that waits for analysis adds latency to every response,
 * and this one waits on a model for ~30 seconds.
 *
 * ── Principle Zero, with an extra edge ─────────────────────────────────────
 *
 * Exits 0 whatever happens, has an explicit timeout, and trips a breaker after
 * repeated failure. The edge this one has over the standing pass: it spends the
 * user's money. A loop here is not a wasted CPU cycle, so the breaker matters
 * more and the ledger is written **before** interpretation rather than after —
 * a crash while parsing a response must not cause the same batch to be paid
 * for twice.
 *
 * ── Why the child is a real session, and what that costs ───────────────────
 *
 * `claude --bare` would skip hooks, plugin sync and auto-memory, which is
 * exactly what is wanted — but its auth becomes "strictly ANTHROPIC_API_KEY",
 * and on a subscription it returns `is_error: true` with "Not logged in"
 * having called nothing. So the child runs normally and writes its own
 * transcript.
 *
 * Three defences, because a judge that judges its own output is a loop that
 * bills:
 *
 * 1. `AGENTSENSEI_DISABLE=1` in the child's environment — our own hooks
 *    short-circuit on line one.
 * 2. A dedicated working directory containing `JUDGE_CWD_MARKER`, which
 *    `discoverTranscripts` filters out.
 * 3. The ledger, which would decline to re-judge the same bytes anyway.
 *
 * Measured before these existed: three probe calls took this machine from 9
 * discovered sessions to 12.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordFailure, recordSuccess, isTripped, readBreaker } from '../src/breaker.ts';
import { resolveConfig } from '../src/config.ts';
import { parse } from '../src/parsers/index.ts';
import { discoverTranscripts, JUDGE_CWD_MARKER } from '../src/read.ts';
import { buildSkeletons } from '../src/skeleton.ts';
import {
  buildSession, openFailuresBefore, parseResponse, renderPacket,
  type JudgeCarry, type JudgePacketSession,
} from '../src/judge.ts';
import { readJudgeState, writeJudgeState, type JudgeState } from '../src/judge-store.ts';
import type { Event } from '../src/types.ts';

/** Well under any reasonable hook budget, and the model call is the long pole. */
const TIMEOUT_MS = 180_000;

/** Where the child runs. The marker is what keeps its transcript out of ours. */
function judgeCwd(): string {
  const dir = join(tmpdir(), JUDGE_CWD_MARKER);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** One model call. Returns the raw reply and what it cost, or undefined. */
function callModel(
  packet: string,
  model: string,
): { reply: string; inputTokens: number; outputTokens: number } | undefined {
  try {
    const out = execFileSync(
      'claude',
      ['-p', packet, '--output-format', 'json', '--allowed-tools', '', '--model', model],
      {
        cwd: judgeCwd(),
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, AGENTSENSEI_DISABLE: '1' },
      },
    );
    const parsed = JSON.parse(out) as {
      is_error?: boolean;
      result?: string;
      usage?: Record<string, number>;
    };
    // `is_error`, never `subtype`: a not-logged-in reply sets `is_error: true`
    // while `subtype` still reads "success".
    if (parsed.is_error === true || typeof parsed.result !== 'string') return undefined;
    const u = parsed.usage ?? {};
    return {
      reply: parsed.result,
      inputTokens:
        (u['cache_creation_input_tokens'] ?? 0) +
        (u['cache_read_input_tokens'] ?? 0) +
        (u['input_tokens'] ?? 0),
      outputTokens: u['output_tokens'] ?? 0,
    };
  } catch {
    return undefined;
  }
}

/** The carry for a session already judged up to `offset` bytes. */
function carryFor(state: JudgeState, sessionId: string, events: Event[], fromSeq: number): JudgeCarry {
  return {
    openFailures: openFailuresBefore(events, fromSeq),
    reported: state.findings
      .filter((f) => f.sessionId === sessionId)
      .map((f) => ({ dimension: f.dimension, turns: f.turns })),
    turnsJudged: fromSeq,
  };
}

async function main(): Promise<void> {
  if (process.env['AGENTSENSEI_DISABLE'] === '1') return;

  const { config } = resolveConfig();
  const state = readJudgeState(config.archive);
  if (!state.settings.enabled) return;
  if (isTripped(readBreaker(config.archive))) return;

  const only = process.argv[2];

  // Build one packet across every session with new bytes. Batching is the whole
  // cost argument: the ~27,000-token invocation overhead dwarfs a ~2,800-token
  // session, so N sessions in one call rather than N calls.
  const sessions: JudgePacketSession[] = [];
  const offsets = new Map<string, number>();

  for (const source of discoverTranscripts(config.sources)) {
    const sessionId = basename(source, '.jsonl');
    if (only !== undefined && !sessionId.startsWith(only)) continue;

    let size: number;
    try {
      size = statSync(source).size;
    } catch {
      continue;
    }
    const judged = state.ledger[sessionId] ?? 0;
    if (size <= judged) continue;

    let events: Event[];
    try {
      events = [...parse(source, readFileSync(source, 'utf8'), sessionId).events].sort(
        (a, b) => a.seq - b.seq,
      );
    } catch {
      continue;
    }
    if (events.length === 0) continue;

    // Where the last pass stopped, in turns. Everything before is carried, not
    // re-sent: re-judging turns already paid for is the one waste this tool
    // would be least able to defend.
    const fromSeq = judged === 0 ? 0 : Math.floor((judged / size) * events.length);
    const fresh = events.filter((e) => e.seq >= fromSeq);
    if (fresh.length === 0) continue;

    const packet = buildSession(
      sessionId,
      fresh,
      buildSkeletons(sessionId, fresh),
      judged === 0 ? undefined : carryFor(state, sessionId, events, fromSeq),
    );
    if (packet.windows.length === 0) {
      // Nothing worth judging, but the bytes are still read — record it so the
      // same quiet stretch is not reconsidered every single pass.
      offsets.set(sessionId, size);
      continue;
    }
    sessions.push(packet);
    offsets.set(sessionId, size);
  }

  if (sessions.length === 0) {
    if (offsets.size > 0) {
      for (const [id, off] of offsets) state.ledger[id] = off;
      writeJudgeState(config.archive, state);
    }
    return;
  }

  // ── Fill to the ceiling, do not reject at it ─────────────────────────────
  //
  // A first pass over a long history is easily several times the budget — four
  // of this machine's sessions come to ~83,000 tokens against a 60,000 ceiling.
  // Rejecting the batch would mean such a user never gets a single judge pass,
  // which is the worst of both outcomes: billed nothing, told nothing.
  //
  // So whole sessions are taken until the next one would not fit, and the rest
  // wait for the following pass. **Whole sessions**, never a truncated one: a
  // packet cut in half yields findings about turns whose other half the judge
  // could not see.
  const batch: JudgePacketSession[] = [];
  const deferred: string[] = [];
  for (const session of sessions) {
    const candidate = [...batch, session];
    if (Math.round((renderPacket(candidate).length / 4) * 1.9) > state.settings.maxBatchTokens) {
      if (batch.length === 0) {
        // One session alone is over budget. It can never be sent as it stands,
        // so say so rather than looping on it every pass.
        recordFailure(config.archive, `session ${session.sessionId} exceeds the judge budget alone`);
        continue;
      }
      deferred.push(session.sessionId);
      continue;
    }
    batch.push(session);
  }
  if (batch.length === 0) return;

  // Only what is actually sent advances the ledger.
  for (const id of deferred) offsets.delete(id);
  for (const s of sessions) {
    if (!batch.some((b) => b.sessionId === s.sessionId)) offsets.delete(s.sessionId);
  }

  const packet = renderPacket(batch);

  const result = callModel(packet, state.settings.model);
  if (result === undefined) {
    recordFailure(config.archive, 'judge call failed');
    return;
  }

  // Ledger and usage first. If parsing throws below, the batch is still marked
  // paid for, because it was.
  for (const [id, off] of offsets) state.ledger[id] = off;
  state.usage = {
    calls: state.usage.calls + 1,
    inputTokens: state.usage.inputTokens + result.inputTokens,
    outputTokens: state.usage.outputTokens + result.outputTokens,
  };
  writeJudgeState(config.archive, state);

  const { findings } = parseResponse(result.reply, batch);
  const at = new Date().toISOString();
  state.findings = [...state.findings, ...findings.map((f) => ({ ...f, at }))];
  writeJudgeState(config.archive, state);
  recordSuccess(config.archive);
}

main().catch(() => {
  // Principle Zero: a broken analyzer must never break a session.
});
