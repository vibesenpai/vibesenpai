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

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { recordFailure, recordSuccess, isTripped, readBreaker } from '../src/breaker.ts';
import { callModel, wouldLeak } from '../src/model.ts';
import { resolveConfig } from '../src/config.ts';
import { parseTranscript, withFullText } from '../src/parsers/claude-code.ts';
import { discoverTranscripts } from '../src/read.ts';

import {
  buildSession, estimateTokens, openFailuresBefore, parseExtract, parseLabels, renderExtract, renderLabel,
  type JudgeCarry, type JudgePacketSession,
} from '../src/judge.ts';
import {
  clearJudgeRunning, readJudgeState, writeJudgeState, type JudgeState,
} from '../src/judge-store.ts';
import type { Event } from '../src/types.ts';

/** Well under any reasonable hook budget, and the model call is the long pole. */
const TIMEOUT_MS = 180_000;

/**
 * Refuse to send anything redaction would still change.
 *
 * **Asserted here, not merely in a test.** The packet leaves the machine, and
 * every input to it is redacted already — the parser does it, `packet.ts` does
 * it as its last construction step. This catches the case those cannot: a
 * future path that assembles a packet without coming through the builder.
 *
 * Measured: **50% of corpus sessions carry secret-class content** at this
 * fidelity — `secret-assignment`, `api-key`, `jwt`, `url-credentials`,
 * `bearer` — and tool output is where they concentrate. A warning would not
 * do; a warning in a detached process is a thing nobody reads.
 *
 * The offending text is never logged, only the fact and the sessions.
 */
function refuseIfUnredacted(packet: string, sessionIds: string[]): boolean {
  if (!wouldLeak(packet)) return false;
  recordFailure(
    resolveConfig().config.archive,
    `judge packet failed the redaction gate (${sessionIds.length} session(s)); nothing sent`,
  );
  return true;
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
  // cost argument: the 26,384-token invocation overhead dwarfs a ~8,634-token
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
    let fullText: Map<number, string>;
    try {
      const r = withFullText(() =>
        parseTranscript(readFileSync(source, 'utf8').split('\n'), sessionId),
      );
      events = [...r.result.events].sort((a, b) => a.seq - b.seq);
      fullText = r.fullText;
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
      fullText,
      judged === 0 ? undefined : carryFor(state, sessionId, events, fromSeq),
    );
    if (packet.packet.turns.length === 0) {
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
    if (estimateTokens(renderExtract(candidate)) > state.settings.maxBatchTokens) {
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

  // ── Stage A: extract, without labelling ──────────────────────────────────
  //
  // Measured on the full labelled set — 246 sessions, 557 claims — against the
  // single-pass prompt this replaces:
  //
  //   single-pass   129/232 session   196/437 episode   119/557 claim
  //   two-stage     165/232           290/437           175/557
  //
  // +15 points of session recall, and precision barely moved: false positives
  // on 319 labelled-clean sessions went 123 -> 149, so true-catch per false
  // alarm actually improved, 1.05 -> 1.11.
  //
  // The reason is structural rather than a better prompt. Asking one model to
  // read a transcript, recognise an episode AND choose one of four labels is a
  // job the paper's own pipeline never gives anyone: `extraction_prompt.md`
  // never mentions S1-S8. `misread_intent` more than doubled (28 -> 64) when
  // the choice moved out of extraction, which is exactly the dimension hardest
  // to pick while reading.
  const extractPacket = renderExtract(batch);
  if (refuseIfUnredacted(extractPacket, batch.map((b) => b.sessionId))) return;

  const extracted = callModel(extractPacket, state.settings.model, { timeoutMs: TIMEOUT_MS, maxBufferBytes: 32 * 1024 * 1024 });
  if (extracted === undefined) {
    recordFailure(config.archive, 'judge extract call failed');
    return;
  }

  // Ledger and usage first. If anything below throws, the batch is still marked
  // paid for, because it was.
  for (const [id, off] of offsets) state.ledger[id] = off;
  state.usage = {
    calls: state.usage.calls + 1,
    inputTokens: state.usage.inputTokens + extracted.inputTokens,
    outputTokens: state.usage.outputTokens + extracted.outputTokens,
  };
  writeJudgeState(config.archive, state);

  const { episodes } = parseExtract(extracted.reply, batch);
  if (episodes.length === 0) {
    // Nothing to label, and that is the common case. Stage B is not worth an
    // invocation's overhead for an empty list.
    recordSuccess(config.archive);
    return;
  }

  // ── Stage B: label the records ───────────────────────────────────────────
  //
  // Reads RECORDS, not transcripts — a record is ~748 tokens against a ~8,634
  // token packet. It is still a separate invocation and so pays the full 26,384
  // of overhead: measured, two-stage ran 195 calls where single-pass ran 98,
  // and cost $2.81 against $1.88. ~1.5x, not the 8% a token-only estimate
  // suggested.
  //
  // The extract packet already passed the leak gate and a record is built from
  // its quotes, but the gate runs again because it guards what leaves the
  // machine and this is a different string leaving it.
  const labelPacket = renderLabel(episodes);
  if (refuseIfUnredacted(labelPacket, batch.map((b) => b.sessionId))) return;

  const labelled = callModel(labelPacket, state.settings.model, { timeoutMs: TIMEOUT_MS, maxBufferBytes: 32 * 1024 * 1024 });
  if (labelled === undefined) {
    // Stage A is already paid for and its episodes are real. Losing them to a
    // stage-B failure would mean paying twice for the same reading.
    recordFailure(config.archive, `judge label call failed; ${episodes.length} episode(s) unlabelled`);
    return;
  }
  state.usage = {
    calls: state.usage.calls + 1,
    inputTokens: state.usage.inputTokens + labelled.inputTokens,
    outputTokens: state.usage.outputTokens + labelled.outputTokens,
  };
  writeJudgeState(config.archive, state);

  const { findings } = parseLabels(labelled.reply, episodes);
  const at = new Date().toISOString();
  state.findings = [...state.findings, ...findings.map((f) => ({ ...f, at }))];
  writeJudgeState(config.archive, state);
  recordSuccess(config.archive);
}

// ── Release the in-flight marker, however this exits ──────────────────────
//
// The CLI takes it before spawning, because the ledger does not move until
// stage A returns and two `now` calls inside that window would otherwise both
// spend ~58k tokens on the same bytes. `finally` rather than a success path:
// a crashed pass that held the marker would block every later one until it
// aged out, turning one failure into five minutes of silence.
main()
  .catch(() => {
    // Principle Zero: a broken analyzer must never break a session.
  })
  .finally(() => {
    try {
      clearJudgeRunning(resolveConfig().config.archive);
    } catch {
      // Staleness covers it.
    }
  });
