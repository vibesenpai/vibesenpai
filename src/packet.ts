/**
 * The session as a **model** reads it, not as a terminal shows it.
 *
 * ── The mistake this replaces ──────────────────────────────────────────────
 *
 * The judge was fed `textSummary`, which exists so an evidence row fits in 80
 * columns: 200 characters, cut head-only. Measured over 300 corpus sessions,
 * that discarded **54% of all assistant prose** — 3.28M of 6.03M characters —
 * and because the cut was head-only, what went was the **end**, where an agent
 * puts its verdict. "…ran the suite, *all tests pass*" is the sentence
 * `inaccurate_self_report` exists to find, and it was deleted before the judge
 * looked.
 *
 * One constant was serving two jobs. `textSummary` keeps the rendering job and
 * is untouched; this module does the other one.
 *
 * ── The policy, from the paper's formatter ─────────────────────────────────
 *
 * `session-formatting/format_sessions.py` in the replication package for
 * arXiv 2605.29442, and it is asymmetric on purpose:
 *
 * ```python
 *   if role == "USER":  return np.inf        # never truncated
 *   agent_max = 5000 if turns<=8 else 3000 if turns<=16
 *               else 2000 if turns<=42 else 1000 if turns<=74 else 500
 * ```
 *
 * The developer's words are whole because they are the thing being violated.
 * The agent absorbs the budget pressure, and the budget shrinks as sessions
 * grow.
 *
 * ── Merge before capping. This is the part that makes it affordable ────────
 *
 * A run of tool calls and results collapses into **one** agent turn, capped
 * once. Without that step each of a session's ~273 messages takes the full
 * budget and the packet explodes. Measured three ways, which is one more than
 * it should have taken:
 *
 * ```
 *   current packet (summaries)        p50  2,800   p90  13,300
 *   prose only, no tool traces        p50  5,994   p90  27,781   (wrong)
 *   cap per message, no merge         p50 72,525   p90 254,561   (wrong)
 *   merge then cap, tool traces in    p50  8,634   p90  17,821   <- this
 * ```
 *
 * 3.1x the old packet at p50, with tool traces fully included and no session
 * exceeding a 60k batch ceiling on its own.
 *
 * The tiers count **merged** turns. On raw message counts almost no corpus
 * session lands in the `<=8` tier; on merged counts roughly half do, close to
 * the paper's stated 62%. Measured over 60 sessions: 0 raw, 28 merged.
 */

import { redact } from './redact.ts';
import type { Event } from './types.ts';

/** `role === "USER"` → `np.inf`. The developer's words are never cut. */
export const PROMPT_UNCAPPED = Number.POSITIVE_INFINITY;

/** Agent budget by merged turn count, exactly as the paper tiers it. */
export function agentBudget(mergedTurns: number): number {
  if (mergedTurns <= 8) return 5000;
  if (mergedTurns <= 16) return 3000;
  if (mergedTurns <= 42) return 2000;
  if (mergedTurns <= 74) return 1000;
  return 500;
}

/**
 * Head and tail, with the omission counted.
 *
 * Head-only was the original defect: an agent's conclusion is at the end. The
 * stated count lets a reader — or a model quoting it — tell a short message
 * from a gutted one.
 */
export function truncate(text: string, max: number): string {
  if (!Number.isFinite(max) || text.length <= max) return text;
  const head = Math.floor(max * 0.5);
  const tail = max - head;
  return (
    `${endBeforeMarker(text.slice(0, head))}` +
    `\n… [${text.length - max} chars omitted] …\n` +
    `${startAfterMarker(text.slice(-tail))}`
  );
}

/**
 * Never cut through a redaction marker.
 *
 * **Measured, and it defeated the gate before it defeated anything else.**
 * Slicing `/Users/[USER]` at the wrong offset leaves `/Users/[USER`, which
 * redaction then *repairs* to `/Users/[USER]` — so `redact(packet) !== packet`
 * on a packet that was already perfectly clean. 2 of 60 sessions did it when
 * first measured, and the gate has caught none since.
 *
 * The tempting fix is to re-redact after truncating and compare idempotence
 * instead. That is strictly weaker: `isIdempotent` returns true for text
 * redaction would still change, which is the distinction this project already
 * got wrong once. So the cut moves instead of the gate.
 */
function endBeforeMarker(s: string): string {
  const open = s.lastIndexOf('[');
  const cut = open !== -1 && !s.slice(open).includes(']') ? s.slice(0, open) : s;
  // **Never end on a dangling assignment.** Cutting `API_KEY: <value>` after
  // the colon leaves the omission marker sitting where the value was, and the
  // redactor reads the marker as the secret — `secret-assignment` fired on two
  // corpus sessions for exactly this. Same family as the `[USER]` false
  // redaction this project fixed in `summarise` once before.
  return cut.replace(/[\s]*[:=]\s*$/, '');
}

function startAfterMarker(s: string): string {
  const close = s.indexOf(']');
  const open = s.indexOf('[');
  return close !== -1 && (open === -1 || close < open) ? s.slice(close + 1) : s;
}

export type PacketTurn = {
  role: 'USER' | 'AGENT';
  /** Turns merged into this one, so a quote can be traced back. */
  seqs: number[];
  text: string;
  /**
   * Each constituent turn's own text, kept so a quote can name its turn.
   *
   * **Without this a quote resolves to the block it is in, not the turn.** A
   * merged agent turn spans a measured p90 of 79 `seq` and a maximum of 454,
   * so returning the first seq put the evidence up to hundreds of turns from
   * where it actually was — which scored as "right dimension, wrong place"
   * and was mistaken for a judge failure.
   *
   * **It holds text rather than offsets, and that is the whole fix.** Offsets
   * were measured against the pre-truncation block, so `buildTurns` had to
   * discard them whenever the text was cut — and `turnForQuote` then fell back
   * to the block's first seq with no error. Measured over 87 findings: 45
   * resolved through that fallback and sat a median **460 seq** from their
   * evidence, against 222 for the ones that resolved exactly. Text cannot go
   * stale, so there is nothing left to invalidate.
   */
  parts: { seq: number; text: string }[];
};

/**
 * A `user` record the harness wrote, not something the developer said.
 *
 * **`command-name` is deliberately NOT filtered.** It was, and that discarded
 * the developer's intent whenever they expressed it as a slash command: the
 * gold evidence for one episode is literally
 * `<command-name>/gsd:discuss-phase</command-name> <command-args>23</command-args>`,
 * and the judge never saw it. One episode in this corpus, but local sessions
 * are full of `/commands` and every one of them was being dropped.
 *
 * `command-message` stays filtered — it is the harness echoing the command back
 * — as do `task-notification` and `local-command`, which no developer typed.
 * Task notifications also arrive as user turns and are long: one filled 600
 * characters of preamble with a tool-use id.
 *
 * **Exported because `judge.ts` had its own copy that disagreed**, still
 * filtering `command-name`. So a slash command survived into the turn body and
 * was stripped from the preamble that claims to list "what the developer asked
 * for, in order" — the one place it most needed to appear. Two functions with
 * one name and different behaviour is how that goes unnoticed.
 */
export function isHarnessNoise(text: string): boolean {
  return /^<(?:task-notification|command-message|local-command)/.test(text);
}

/**
 * One line of transcript as the model should see it.
 *
 * Tool calls and results are rendered as agent text rather than dropped: S7 is
 * a claim contradicted by a result, and the result is where the contradiction
 * lives. They carry the agent budget, which is what merging makes affordable.
 */
function lineFor(e: Event, full: Map<number, string>): { role: 'USER' | 'AGENT'; text: string } | undefined {
  const text = full.get(e.seq) ?? e.textSummary ?? '';

  switch (e.turnType) {
    case 'user_prompt':
      return text.trim() === '' || isHarnessNoise(text) ? undefined : { role: 'USER', text };
    case 'assistant_msg':
      return text.trim() === '' ? undefined : { role: 'AGENT', text };
    case 'tool_use': {
      const target = e.filePath ?? e.pattern ?? e.command ?? '';
      return { role: 'AGENT', text: `[${e.toolName ?? 'tool'}] ${target}`.trimEnd() };
    }
    case 'tool_result': {
      const mark = e.isError === true ? 'FAILED' : 'ok';
      return { role: 'AGENT', text: `[result ${mark}] ${text}`.trimEnd() };
    }
    default:
      return undefined;
  }
}

/**
 * Merge consecutive same-role turns, then cap each merged turn once.
 *
 * The order is the whole point. Capping first and merging after would let a
 * tool-heavy session spend the budget hundreds of times over.
 */
export function buildTurns(events: Event[], full: Map<number, string>): PacketTurn[] {
  const merged: PacketTurn[] = [];
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const line = lineFor(e, full);
    if (line === undefined) continue;
    const last = merged[merged.length - 1];
    if (last !== undefined && last.role === line.role) {
      last.text += `\n\n${line.text}`;
      last.seqs.push(e.seq);
      last.parts.push({ seq: e.seq, text: line.text });
    } else {
      merged.push({
        role: line.role,
        seqs: [e.seq],
        text: line.text,
        parts: [{ seq: e.seq, text: line.text }],
      });
    }
  }

  const budget = agentBudget(merged.length);
  // `parts` survives truncation untouched: it holds each turn's own text, so
  // cutting the rendered block cannot move anything. The rendered text is what
  // the model sees and what the gate checks; `parts` is only ever used to name
  // the turn a quote came from.
  return merged.map((t) => ({
    ...t,
    text: truncate(t.text, t.role === 'USER' ? PROMPT_UNCAPPED : budget),
  }));
}

export type SessionPacket = {
  sessionId: string;
  turns: PacketTurn[];
  /** Every seq the packet shows, for anchoring a quote back to a turn. */
  seqs: number[];
};

export function buildPacket(
  sessionId: string,
  events: Event[],
  full: Map<number, string>,
): SessionPacket {
  // There was an `agentBudgetScale` option here, the un-wired remnant of a
  // degrade-until-it-fits idea. No caller ever passed it, and it re-truncated
  // while carrying the original offsets forward — wrong turn numbers, no
  // error. Deleted rather than fixed: the batcher takes whole sessions and
  // defers the rest, which is the behaviour that was actually wanted.
  const turns = buildTurns(events, full);
  return {
    sessionId,
    turns,
    seqs: turns.flatMap((t) => t.seqs),
  };
}

/** Render one session. Turn numbers label the merged turn's first seq. */
export function renderSession(p: SessionPacket): string {
  const body = p.turns
    .map((t) => `turn ${t.seqs[0]} | ${t.role}\n${t.text}`)
    .join('\n\n────────────────────────────────────────\n\n');

  // ── Redaction is the last step of construction, not a check ──────────────
  //
  // Every input is already redacted — the parser does it, and `truncate` is
  // careful not to break a marker. This final pass exists because assembly
  // itself can create a pattern that neither input contained: a cut that
  // leaves a dangling key puts the omission marker where a secret would be.
  //
  // It is deliberately **not** the same thing as the send-time gate. That gate
  // asserts `redact(packet) === packet` on whatever is about to leave the
  // machine, and its job is to catch a future path that assembles a packet
  // without coming through here.
  return redact(body).text;
}

/**
 * Which turn or turns a quote came from.
 *
 * The model quotes; we derive the number. It never counts, so it cannot
 * miscount — and a fabricated quote simply is not found, where a fabricated
 * turn number can pass by coincidence and attach to the wrong claim.
 *
 * ── Searched against each turn's own text, never by offset ─────────────────
 *
 * The previous version located the quote in the merged block and then worked
 * out which constituent turn that character offset fell inside. That arithmetic
 * was correct and still gave the wrong answer, because truncating the block
 * moved every offset after the cut — so `buildTurns` discarded `parts` on any
 * truncated block and this function silently returned `seqs[0]`. With a 500
 * character agent budget past 74 merged turns, nearly every long block in a
 * long session took that path.
 *
 * Searching each part's own text has no offsets to go stale.
 *
 * **Returns every match.** Repeated text — a re-pasted instruction, a
 * compaction summary echoing earlier turns — appears more than once, and the
 * first occurrence is not privileged. Returning all of them lets the scorer and
 * the reader see the ambiguity instead of inheriting an arbitrary pick.
 *
 * Matched on a normalised prefix because a model may reflow whitespace or stop
 * short; an exact comparison would fail on the long quotes most worth having.
 */
export function turnsForQuote(p: SessionPacket, quote: string): number[] {
  const needle = quote.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (needle.length < 8) return [];

  const hits: number[] = [];
  for (const t of p.turns) {
    for (const part of t.parts) {
      if (!part.text.replace(/\s+/g, ' ').includes(needle)) continue;
      if (!hits.includes(part.seq)) hits.push(part.seq);
    }
  }
  return hits.sort((a, b) => a - b);
}
