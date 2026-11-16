/**
 * What the next model read would send, built by the same code as the Stop hook's pass and sent nowhere.
 * Nothing is written except the hash marker a yes needs. DECISIONS.md D72; .claude/rules/judge.md.
 */

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { discoverTranscripts } from '../read.ts';
import { catchUpFrom, eligible } from './limits.ts';
import { estimateTokens, JUDGE_OVERHEAD_TOKENS } from './packet.ts';
import { renderExtract } from './prompt.ts';
import { packBatches, planRound } from './run.ts';
import { markPreviewShown, readJudgeState } from './state.ts';

/** One packet the first read would send, exactly as it would be sent, and the sessions in it. */
type PreviewPacket = {
  text: string;
  tokens: number;
  sessions: { sessionId: string; turns: number; chars: number }[];
};

export type Preview = {
  /** The packets the first read would send at once (up to `concurrency`), in order. */
  first: PreviewPacket[];
  /** Everything the reads would go on to send at first: sessions, and an estimate of tokens. */
  then: { sessions: number; tokens: number };
  model: string;
  dailyTokens: number;
  catchUp: number;
  /** sha256 of the first packets' text; a yes records it. */
  hash: string;
};

/**
 * Plan the next read as the Stop hook's pass would: newest first, within the catch-up, the same batching.
 * `mark` records the hash so a yes can follow; the CLI's dry run passes false.
 */
export function previewNextPacket(config: { archive: string; sources: string[] }, mark = true): Preview {
  const found: { id: string; source: string; size: number; mtimeMs: number }[] = [];
  for (const source of discoverTranscripts(config.sources)) {
    try {
      const st = statSync(source);
      found.push({ id: basename(source, '.jsonl'), source, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // Vanished between listing and stat: not part of a pass either.
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const state = readJudgeState(config.archive, { dismissed: 'include' });
  const pick = eligible(state, found, catchUpFrom(config.archive, state, found, false));
  const snapshot = new Map(pick.map((f) => [f.id, { source: f.source, size: f.size }]));

  const round = planRound(config, state, undefined, snapshot, true);
  const { batches } = packBatches(config.archive, round, state.settings.maxBatchTokens, Math.max(1, state.settings.concurrency), true);
  const first = batches.map((b) => {
    const text = renderExtract(b.sessions);
    return {
      text,
      tokens: estimateTokens(text),
      sessions: b.sessions.map((s) => ({
        sessionId: s.sessionId,
        turns: s.packet.turns.length,
        chars: renderExtract([s]).length,
      })),
    };
  });
  // Every pending session packed as passes would pack them, each call with its overhead.
  const all = packBatches(config.archive, round, state.settings.maxBatchTokens, Number.MAX_SAFE_INTEGER, true).batches;
  const then = {
    sessions: round.sessions.length,
    tokens: all.reduce((n, b) => n + estimateTokens(renderExtract(b.sessions)) + JUDGE_OVERHEAD_TOKENS, 0),
  };
  const hash = createHash('sha256').update(first.map((p) => p.text).join('\n\u0000\n')).digest('hex');
  if (mark) markPreviewShown(config.archive, hash);
  return { first, then, model: state.settings.model, dailyTokens: state.settings.dailyTokens, catchUp: state.settings.catchUp, hash };
}
