/**
 * The session as the judge model reads it: full text, merged turns, capped per the paper's formatter
 * (arXiv 2605.29442, `format_sessions.py`). `textSummary` stays the 80-column display form.
 * Prompts are never cut; agent turns are merged first, then capped once by tier.
 */

import { redact } from '../redact.ts';
import type { Event } from '../types.ts';
import { renderExtract, type JudgeDimension } from './prompt.ts';
import type { LookbackSource } from './lookback.ts';

/** The developer's words are never cut. */
const PROMPT_UNCAPPED = Number.POSITIVE_INFINITY;

/** Agent budget by merged turn count, exactly as the paper tiers it. */
export function agentBudget(mergedTurns: number): number {
  if (mergedTurns <= 8) return 5000;
  if (mergedTurns <= 16) return 3000;
  if (mergedTurns <= 42) return 2000;
  if (mergedTurns <= 74) return 1000;
  return 500;
}

/** Head and tail with the omitted count stated; an agent's conclusion is at the end. */
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
 * Never cut through a redaction marker: `/Users/[USER` gets "repaired" by redact, which makes a clean
 * packet fail the `redact(packet) === packet` gate. Move the cut, never weaken the gate.
 */
function endBeforeMarker(s: string): string {
  const open = s.lastIndexOf('[');
  const cut = open !== -1 && !s.slice(open).includes(']') ? s.slice(0, open) : s;
  // Never end on a dangling `KEY:`; the redactor would read the omission marker as its value.
  return cut.replace(/[\s]*[:=]\s*$/, '');
}

function startAfterMarker(s: string): string {
  const close = s.indexOf(']');
  const open = s.indexOf('[');
  return close !== -1 && (open === -1 || close < open) ? s.slice(close + 1) : s;
}

/**
 * The longest word-ending prefix of `s` that redaction leaves unchanged (strict equality).
 * A cut like `Authorization: Beare` otherwise trips the gate on every pass. `s` is already redacted.
 */
export function cleanCut(s: string): string {
  let cut = endBeforeMarker(s);
  while (cut !== '' && redact(cut).text !== cut) {
    const space = cut.search(/\s\S*$/);
    cut = endBeforeMarker(space <= 0 ? '' : cut.slice(0, space));
  }
  return cut;
}

type PacketTurn = {
  role: 'USER' | 'AGENT';
  /** Turns merged into this one, so a quote can be traced back. */
  seqs: number[];
  text: string;
  /**
   * Each constituent turn's own text, so a quote resolves to its turn, not the merged block.
   * Text, not offsets: offsets go stale when the block is truncated.
   */
  parts: { seq: number; text: string }[];
};

/**
 * A `user` record the harness wrote, not something the developer said.
 * `command-name` is deliberately kept: a slash command is the developer's intent.
 */
export function isHarnessNoise(text: string): boolean {
  return /^<(?:task-notification|command-message|local-command)/.test(text);
}

/** How much of a developer command's instructions the packet carries: 2,000 held 62 of 91 gold quotes, 600 held 28. */
export const COMMAND_BODY_MAX = 2000;

/** One line of transcript as the model should see it. Tool calls and results are kept: S7 lives there. */
function lineFor(e: Event, full: Map<number, string>, shown: Set<string>): { role: 'USER' | 'AGENT'; text: string } | undefined {
  const text = full.get(e.seq) ?? e.textSummary ?? '';

  // A developer's command and its instructions, as the parser marked them; its output stays out.
  if (e.devCommand !== undefined) {
    if (text.trim() === '') return undefined;
    if (e.devCommand.part === 'invocation') return { role: 'USER', text };
    const { name } = e.devCommand;
    // Once per packet: a command run again carries the same instructions.
    if (shown.has(name)) return { role: 'USER', text: `[instructions of ${name}, as above]` };
    shown.add(name);
    const body = text.length <= COMMAND_BODY_MAX ? text : cleanCut(text.slice(0, COMMAND_BODY_MAX));
    return { role: 'USER', text: `[instructions of ${name}] ${body}` };
  }

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

/** Merge consecutive same-role turns, then cap each merged turn once. Capping first would blow the budget. */
export function buildTurns(events: Event[], full: Map<number, string>): PacketTurn[] {
  const merged: PacketTurn[] = [];
  const shown = new Set<string>();
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const line = lineFor(e, full, shown);
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
  // `parts` is left untruncated; it only names the turn a quote came from.
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

  // Final redaction pass: assembly can create a pattern no input had. This is construction,
  // not the send-time gate, which still asserts `redact(packet) === packet` before every call.
  return redact(body).text;
}

/**
 * Which turns a quote came from; the model quotes and we derive the number, so it cannot miscount.
 * Returns every match (repeated text is ambiguous). Matched on a whitespace-normalised 60-char prefix.
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

/**
 * What the judge is told about earlier batches: open failures (so S7 survives batching), findings
 * already reported, turns judged. Computed, never model-written, and capped.
 */
export type JudgeCarry = {
  /** Failures with no later success on the same target. The S7 trigger. */
  openFailures: { turn: number; what: string }[];
  /** Already reported, so the judge does not say it twice. */
  reported: { dimension: JudgeDimension; turns: number[] }[];
  /** Turns judged so far, so "earlier" has a shape. */
  turnsJudged: number;
};

export const CARRY_MAX_OPEN_FAILURES = 8;

export type JudgePacketSession = {
  sessionId: string;
  /** The session as the model reads it. */
  packet: SessionPacket;
  /** Every user prompt, labelled by its real turn number, never by list position. */
  prompts: { turn: number; text: string }[];
  /** Turn numbers the packet actually contains, for anchoring. */
  turns: number[];
  /** What happened before these windows. Absent on the first batch. */
  carry?: JudgeCarry;
  /** Earlier prompts and loaded instructions, for the label stage. Present when the `lookback` setting is on. */
  lookback?: LookbackSource;
};

/**
 * Failures from earlier turns that no later success on the same target has resolved.
 * Deliberately over-forgives: a stale entry would invite a false finding.
 */
export function openFailuresBefore(events: Event[], before: number): JudgeCarry['openFailures'] {
  const failed = new Map<string, { turn: number; what: string }>();
  for (const e of events) {
    if (e.seq >= before) break;
    const target = e.filePath ?? e.toolName;
    if (target === undefined) continue;
    if (e.turnType === 'tool_result' && e.isError === true) {
      failed.set(target, { turn: e.seq, what: `${e.toolName ?? 'tool'} ${e.filePath ?? ''}`.trim() });
    } else if (e.turnType === 'tool_result' && e.isError !== true) {
      failed.delete(target);
    }
  }
  return [...failed.values()].slice(-CARRY_MAX_OPEN_FAILURES);
}

/** Each prompt in the preamble is capped; one pasted log must not be the packet. */
export const PREAMBLE_PROMPT_MAX = 600;

/** Measured per-call input overhead of the `claude -p` child (its own system prompt and tools). */
export const JUDGE_OVERHEAD_TOKENS = 26_384;

/**
 * Token estimate for a packet. `len / 4` runs ~1.9x low against what the harness bills.
 * Size the exact string you send (`renderExtract`), through this one function.
 */
export function estimateTokens(packet: string): number {
  return Math.round((packet.length / 4) * 1.9);
}

export function buildSession(
  sessionId: string,
  events: Event[],
  fullText: Map<number, string>,
  carry?: JudgeCarry,
): JudgePacketSession {
  // Capped here only; the turns below carry every prompt whole.
  const prompts: { turn: number; text: string }[] = [];
  for (const e of events) {
    // A developer's slash command is a request too: its name and arguments, not its instructions.
    const isRequest = e.turnType === 'user_prompt' || e.devCommand?.part === 'invocation';
    const t = isRequest ? (fullText.get(e.seq) ?? e.textSummary ?? '').trim() : '';
    if (t === '' || isHarnessNoise(t)) continue;
    // `cleanCut`, not a bare slice, so the cut cannot leave a fragment the gate reads as a secret.
    prompts.push({ turn: e.seq, text: t.length <= PREAMBLE_PROMPT_MAX ? t : cleanCut(t.slice(0, PREAMBLE_PROMPT_MAX)) });
  }

  const packet = buildPacket(sessionId, events, fullText);
  return {
    sessionId,
    prompts,
    packet,
    turns: packet.seqs,
    ...(carry !== undefined ? { carry } : {}),
  };
}

/**
 * The longest run of turns from the front of `fresh` that fits one packet, so an oversize session is
 * read in windows rather than skipped forever. `undefined` means not even one turn fits.
 */
export function largestFittingWindow(
  sessionId: string,
  fresh: Event[],
  fullText: Map<number, string>,
  carry: JudgeCarry | undefined,
  budget: number,
): { session: JudgePacketSession; turns: number } | undefined {
  const build = (n: number): JudgePacketSession =>
    buildSession(sessionId, fresh.slice(0, n), fullText, carry);
  // Search on budget alone; "has a turn" is checked once at the end, since a session's first
  // events often make no turn. Tokens are not strictly monotonic, so this may stop short, never over.
  const fits = (n: number): boolean => estimateTokens(renderExtract([build(n)])) <= budget;

  if (!fits(1)) return undefined;

  let lo = 1;
  let hi = fresh.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  const session = build(lo);
  return session.packet.turns.length === 0 ? undefined : { session, turns: lo };
}

/**
 * The next part of a turn too large for any packet (only an uncapped prompt can be), labelled with
 * its character range. Each part starts where the last stopped; `resume` applies only to the same turn.
 * `undefined` means not even one character fits beside what is carried.
 */
export function partOfTurn(
  sessionId: string,
  fresh: Event[],
  fullText: Map<number, string>,
  carry: JudgeCarry | undefined,
  budget: number,
  resume?: { seq: number; chars: number },
): { session: JudgePacketSession; turns: number; seq: number; end: number; length: number } | undefined {
  let n = 1;
  while (n <= fresh.length && buildSession(sessionId, fresh.slice(0, n), fullText).packet.turns.length === 0) n += 1;
  const event = fresh[n - 1];
  if (event === undefined || n > fresh.length) return undefined;

  const text = fullText.get(event.seq) ?? event.textSummary ?? '';
  const from = resume !== undefined && resume.seq === event.seq && resume.chars < text.length ? resume.chars : 0;

  const build = (end: number): JudgePacketSession => {
    const part = new Map(fullText);
    part.set(
      event.seq,
      `[one message sent in parts: characters ${from + 1}-${end} of ${text.length}]\n${text.slice(from, end)}`,
    );
    return buildSession(sessionId, fresh.slice(0, n), part, carry);
  };
  const fits = (len: number): boolean => estimateTokens(renderExtract([build(from + len)])) <= budget;

  if (!fits(1)) return undefined;
  let lo = 1;
  let hi = text.length - from;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }

  // Pull back to a clean cut unless this part ends the message. Never to zero (no progress);
  // a part that can only end dirty is sent and refused by the gate, visibly.
  const cut = from + lo === text.length ? lo : cleanCut(text.slice(from, from + lo)).length;
  const end = from + (cut > 0 ? cut : lo);
  return { session: build(end), turns: n, seq: event.seq, end, length: text.length };
}
