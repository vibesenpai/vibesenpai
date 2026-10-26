/** One judge round: plan what to send, pack it into batches, send a batch and record the result. */

import { readFileSync } from 'node:fs';
import { endRun, markSkipped, openStore, startRun, withStore } from '../store.ts';
import { callModelAsync, wouldLeak } from './model.ts';
import { parseTranscript, withFullText } from '../parsers/claude-code.ts';
import { parseExtract, parseLabels, renderExtract, renderLabel } from './prompt.ts';
import {
  buildSession, estimateTokens, largestFittingWindow, openFailuresBefore, partOfTurn,
  type JudgeCarry, type JudgePacketSession,
} from './packet.ts';
import { recordPass, recordSpend, type JudgeState } from './state.ts';
import type { Event } from '../types.ts';

/** Well under any reasonable hook budget, and the model call is the long pole. */
export const TIMEOUT_MS = 180_000;

/** The carry for a session already judged up to `offset` bytes. */
export function carryFor(state: JudgeState, sessionId: string, events: Event[], fromSeq: number): JudgeCarry {
  return {
    openFailures: openFailuresBefore(events, fromSeq),
    reported: state.findings
      .filter((f) => f.sessionId === sessionId)
      .map((f) => ({ dimension: f.dimension, turns: f.turns })),
    turnsJudged: fromSeq,
  };
}

/**
 * The byte watermark that resumes at turn `turn`, and no earlier.
 * Rounds up: resuming one turn early would re-read a just-finished oversized turn for ever.
 */
export function byteAfter(turn: number, turns: number, size: number): number {
  let b = Math.ceil((turn / turns) * size);
  while (b < size && Math.floor((b / size) * turns) < turn) b += 1;
  return Math.min(b, size);
}

/** Mark a session no packet can hold, without opening a store at every caller. */
export function skipSession(archive: string, sessionId: string, reason: string): void {
  try {
    const db = openStore(archive);
    try {
      markSkipped(db, sessionId, reason);
    } finally {
      db.close();
    }
  } catch {
    // Principle Zero: a failed skip record only means the session is reconsidered next time.
  }
}

export type Parts = Map<string, { seq: number; chars: number } | undefined>;

/** Packets to send, and the progress (byte offsets, part cursors) each stands for if it succeeds. A round is one; so is each batch cut from it. */
export type Batch = { sessions: JudgePacketSession[]; offsets: Map<string, number>; parts: Parts };

/**
 * Every session with new bytes, as at most one packet each: a session's windows run in order,
 * each with the carry of the one before.
 */
export function planRound(
  config: { archive: string; sources: string[] },
  state: JudgeState,
  only: string | undefined,
  snapshot: Map<string, { source: string; size: number }>,
): Batch {
  // Batched because the per-call overhead dwarfs a typical session.
  const sessions: JudgePacketSession[] = [];
  const offsets = new Map<string, number>();
  // Progress inside an oversized turn; handled exactly like `offsets`.
  const parts: Parts = new Map();

  for (const [sessionId, { source, size: at }] of snapshot) {
    if (only !== undefined && !sessionId.startsWith(only)) continue;

    // Only the bytes present when the pass began, in whole lines; a live session keeps growing.
    let text: string;
    let size: number;
    try {
      const head = readFileSync(source).subarray(0, at);
      size = head.lastIndexOf(0x0a) + 1;
      text = head.subarray(0, size).toString('utf8');
    } catch {
      continue;
    }
    const judged = state.ledger[sessionId] ?? 0;
    if (size <= judged) continue;

    let events: Event[];
    let fullText: Map<number, string>;
    try {
      const r = withFullText(() =>
        parseTranscript(text.split('\n'), sessionId),
      );
      events = [...r.result.events].sort((a, b) => a.seq - b.seq);
      fullText = r.fullText;
    } catch {
      continue;
    }
    if (events.length === 0) continue;

    // Resume where the last pass stopped; earlier turns are carried, not re-sent.
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
      // Nothing worth judging, but record the bytes as read.
      offsets.set(sessionId, size);
      continue;
    }

    // Too big for one packet: read it in windows (windowed here, where events and size are in scope).
    if (estimateTokens(renderExtract([packet])) > state.settings.maxBatchTokens) {
      const resume = state.parts?.[sessionId];
      // A part already sent may have produced findings even at judged === 0, so carry then too.
      const carry =
        judged === 0 && resume === undefined ? undefined : carryFor(state, sessionId, events, fromSeq);
      const firstFresh = events.length - fresh.length;
      const win = largestFittingWindow(
        sessionId,
        fresh,
        fullText,
        carry,
        state.settings.maxBatchTokens,
      );
      if (win === undefined) {
        // Not even one turn fits: read that turn in parts.
        const part = partOfTurn(sessionId, fresh, fullText, carry, state.settings.maxBatchTokens, resume);
        if (part === undefined) {
          // Only the carry can leave no room; a property of the data, so a skip, not a breaker failure.
          skipSession(config.archive, sessionId, 'what is carried leaves no room for the next turn');
          continue;
        }
        sessions.push(part.session);
        if (part.end < part.length) {
          parts.set(sessionId, { seq: part.seq, chars: part.end });
        } else {
          parts.set(sessionId, undefined);
          offsets.set(sessionId, byteAfter(firstFresh + part.turns, events.length, size));
        }
        continue;
      }
      sessions.push(win.session);

      // Where this window stopped, in bytes. `byteAfter`, not round-down: rounding down can
      // resume a one-event window on itself, so the session never advances and bills every pass.
      offsets.set(sessionId, byteAfter(firstFresh + win.turns, events.length, size));
      continue;
    }

    sessions.push(packet);
    offsets.set(sessionId, size);
  }

  return { sessions, offsets, parts };
}


/**
 * Up to `k` batches from a round, each within the budget. `quiet` is progress that needs no call:
 * sessions read and found to hold nothing worth judging.
 */
export function packBatches(
  archive: string,
  round: Batch,
  maxBatchTokens: number,
  k: number,
): { batches: Batch[]; quiet: Batch } {
  // First-fit whole sessions up to the ceiling; the rest wait for the next pass. Never a truncated session.
  const batches: JudgePacketSession[][] = [];
  for (const session of round.sessions) {
    const home = batches.find(
      (b) => estimateTokens(renderExtract([...b, session])) <= maxBatchTokens,
    );
    if (home !== undefined) {
      home.push(session);
      continue;
    }
    if (estimateTokens(renderExtract([session])) > maxBatchTokens) {
        // Unreachable (packets are windowed as built); a skip, not a breaker failure, if that ever breaks.
        skipSession(archive, session.sessionId, 'did not fit a packet of its own');
      continue;
    }
    if (batches.length < k) batches.push([session]);
    // Otherwise deferred to the next round, which reads it from its watermark.
  }

  // Only what is sent advances the ledger. Quiet sessions' progress is returned separately.
  const progressOf = (ids: Set<string>): Batch => ({
    sessions: [],
    offsets: new Map([...round.offsets].filter(([id]) => ids.has(id))),
    parts: new Map([...round.parts].filter(([id]) => ids.has(id))),
  });
  const packed = new Set(round.sessions.map((x) => x.sessionId));
  const quietIds = new Set([...round.offsets.keys(), ...round.parts.keys()].filter((id) => !packed.has(id)));
  return {
    batches: batches.map((b) => ({ ...progressOf(new Set(b.map((x) => x.sessionId))), sessions: b })),
    quiet: progressOf(quietIds),
  };
}

/**
 * One batch: extract, label if anything was found, record.
 * Returns the failure rather than recording it, so one rate limit across a round counts once.
 */
export async function runBatch(archive: string, state: JudgeState, batch: Batch): Promise<string | undefined> {
  let callMs: number | undefined;
  const runId = withStore(archive, (db) => startRun(db, 'judge'));
  // Stage A: extract without labelling. Two stages beat one pass: docs/eval.md.
  const extractPacket = renderExtract(batch.sessions);
  // One run row per batch, so `measuredMsPerToken` measures a call, not concurrent wall-clock.
  const packetTokens = estimateTokens(extractPacket);
  const ids = batch.sessions.map((b) => b.sessionId);
  try {
    if (wouldLeak(extractPacket)) return redactionRefusal(ids);

    const extracted = await callModelAsync(extractPacket, state.settings.model, { timeoutMs: TIMEOUT_MS, maxBufferBytes: 32 * 1024 * 1024 });
    if (extracted?.durationMs !== undefined) callMs = (callMs ?? 0) + extracted.durationMs;
    if (extracted === undefined) return 'judge extract call failed';

    // Spend is recorded now (we paid); the watermark moves only with the findings,
    // so a stage-B failure re-bills instead of losing episodes.
    recordSpend(archive, {
      calls: 1,
      tokensIn: extracted.inputTokens,
      tokensOut: extracted.outputTokens,
    });

    const { episodes } = parseExtract(extracted.reply, batch.sessions);
    if (episodes.length === 0) {
      // Nothing found is a result: record the watermark, skip stage B.
      recordPass(archive, [], batch.offsets, batch.parts);
      return undefined;
    }

    // Stage B: label the records (a separate call, full overhead). The leak gate runs again:
    // it guards every string that leaves the machine.
    const labelPacket = renderLabel(episodes);
    if (wouldLeak(labelPacket)) return redactionRefusal(ids);

    const labelled = await callModelAsync(labelPacket, state.settings.model, { timeoutMs: TIMEOUT_MS, maxBufferBytes: 32 * 1024 * 1024 });
    if (labelled?.durationMs !== undefined) callMs = (callMs ?? 0) + labelled.durationMs;
    if (labelled === undefined) {
      // Nothing recorded, so the watermark stays and these bytes are judged again.
      return `judge label call failed; ${episodes.length} episode(s) unlabelled`;
    }
    recordSpend(archive, {
      calls: 1,
      tokensIn: labelled.inputTokens,
      tokensOut: labelled.outputTokens,
    });

    const { findings } = parseLabels(labelled.reply, episodes);
    const at = new Date().toISOString();
    // Findings and the watermark in one transaction.
    recordPass(archive, findings.map((f) => ({ ...f, at })), batch.offsets, batch.parts);
    return undefined;
  } finally {
    if (runId !== undefined) withStore(archive, (db) => endRun(db, runId, 'done', callMs, packetTokens));
  }
}

/**
 * The refusal for a packet redaction would still change (`wouldLeak`), checked before each send.
 * Catches any path that builds a packet without the builder. Never logs the offending text.
 */
export function redactionRefusal(sessionIds: string[]): string {
  return `judge packet failed the redaction gate (${sessionIds.length} session(s)); nothing sent`;
}
