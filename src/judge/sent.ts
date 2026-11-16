/**
 * What was sent, rebuilt from the transcript and checked against the hash recorded at the call.
 * The store keeps recipes and hashes, never the text. DECISIONS.md D73.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseTranscript, withFullText } from '../parsers/claude-code.ts';
import { REDACT_VERSION } from '../redact.ts';
import type { SentRow } from '../store.ts';
import { buildSession, partOfTurn, type JudgePacketSession, type SentRecipe } from './packet.ts';
import { renderExtract } from './prompt.ts';

export type Rebuilt =
  | { ok: true; text: string; matched: boolean; sessions: { sessionId: string; turns: number; chars: number }[]; note?: string }
  | { ok: false; reason: string };

/** One session's packet, cut from its transcript as the recipe says. Undefined when it cannot be read. */
function rebuildSession(r: SentRecipe): JudgePacketSession | undefined {
  let text: string;
  try {
    const head = readFileSync(r.source).subarray(0, r.size);
    text = head.subarray(0, head.lastIndexOf(0x0a) + 1).toString('utf8');
  } catch {
    return undefined;
  }
  const parsed = withFullText(() => parseTranscript(text.split('\n'), r.sessionId));
  const events = [...parsed.result.events].sort((a, b) => a.seq - b.seq);
  const fresh = events.filter((e) => e.seq >= r.fromSeq);
  if (r.cut.kind === 'whole') return buildSession(r.sessionId, fresh, parsed.fullText, r.carry);
  if (r.cut.kind === 'window') return buildSession(r.sessionId, fresh.slice(0, r.cut.events), parsed.fullText, r.carry);
  return partOfTurn(r.sessionId, fresh, parsed.fullText, r.carry, r.cut.budget, r.cut.resume)?.session;
}

/**
 * Rebuild a step 1 call's text and compare it with the hash taken when it was sent. A step 2 call is built
 * from the model's own reply, so only its composition and hash are kept.
 */
export function rebuildSent(row: SentRow): Rebuilt {
  if (row.stage !== 'extract') return { ok: false, reason: "step 2 is built from the model's reply, so only its size and contents are kept" };
  const recipes = Array.isArray(row.recipes) ? (row.recipes as SentRecipe[]) : [];
  if (recipes.length === 0) return { ok: false, reason: 'this call was recorded before recipes were kept' };
  const sessions: JudgePacketSession[] = [];
  for (const r of recipes) {
    const s = rebuildSession(r);
    if (s === undefined) return { ok: false, reason: `the transcript of session ${r.sessionId.slice(0, 8)} is no longer on disk` };
    sessions.push(s);
  }
  const text = renderExtract(sessions);
  const matched = createHash('sha256').update(text).digest('hex') === row.sha256;
  const note = matched
    ? undefined
    : row.redactVersion !== REDACT_VERSION
      ? 'Redaction has changed since this was sent, so the text differs from what went out.'
      : 'The rebuilt text differs from what was sent; the transcript may have been rewritten since.';
  return {
    ok: true,
    text,
    matched,
    sessions: sessions.map((s) => ({ sessionId: s.sessionId, turns: s.packet.turns.length, chars: renderExtract([s]).length })),
    ...(note === undefined ? {} : { note }),
  };
}
