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
 * The tiers count **merged** turns. On raw message counts 0 of 60 corpus
 * sessions land in the `<=8` tier; on merged counts 28 do, close to the
 * paper's stated 62%.
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
 * on a packet that was already perfectly clean. 2 of 60 sessions did it.
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
};

/** A `user` record the harness wrote, not something the developer said. */
function isHarnessNoise(text: string): boolean {
  return /^<(?:task-notification|command-message|command-name|local-command)/.test(text);
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
    } else {
      merged.push({ role: line.role, seqs: [e.seq], text: line.text });
    }
  }

  const budget = agentBudget(merged.length);
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
  opts: { agentBudgetScale?: number } = {},
): SessionPacket {
  const turns = buildTurns(events, full);
  const scale = opts.agentBudgetScale ?? 1;
  const scaled =
    scale === 1
      ? turns
      : turns.map((t) => ({
          ...t,
          // Only the agent degrades. Prompts stay whole at any scale: halving
          // the developer's instruction would remove the evidence for the two
          // largest dimensions in order to afford the session.
          text: t.role === 'USER' ? t.text : truncate(t.text, agentBudget(turns.length) * scale),
        }));

  return {
    sessionId,
    turns: scaled,
    seqs: scaled.flatMap((t) => t.seqs),
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
 * Which turn a quote came from.
 *
 * The model quotes; we derive the number. It never counts, so it cannot
 * miscount — and a fabricated quote simply is not found, where a fabricated
 * turn number can pass by coincidence and attach to the wrong claim.
 *
 * Matched on a normalised prefix because a model may reflow whitespace or stop
 * short; an exact comparison would fail on the long quotes most worth having.
 */
export function turnForQuote(p: SessionPacket, quote: string): number | undefined {
  const needle = quote.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (needle.length < 8) return undefined;
  for (const t of p.turns) {
    if (t.text.replace(/\s+/g, ' ').includes(needle)) return t.seqs[0];
  }
  return undefined;
}
