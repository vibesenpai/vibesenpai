/**
 * Lookback: what the label stage sees so it can tell a mistake from a suggestion.
 * A misread or a violation must name where the expectation was set before the agent acted:
 * an earlier prompt, a project instruction, or the developer saying it was settled before.
 * Deterministic and offline; the block passes the same leak gate as every packet.
 */

import type { Instruction } from '../parsers/claude-code.ts';
import { cleanCut } from './packet.ts';
import type { JudgeEpisode } from './prompt.ts';

/** What the parse kept for one session: its developer prompts and the instructions the harness loaded. */
export type LookbackSource = { prompts: { seq: number; text: string }[]; instructions: Instruction[] };

type LookbackItem = { kind: 'turn'; seq: number; text: string } | { kind: 'instruction'; source: string; fromSeq: number; text: string };

/**
 * `agentTurns`: the agent's turns in the packet, so the gate can ask whether the agent acted after the source.
 * `developer`: every developer prompt up to the episode, never sent; a developer-reference must quote one.
 */
export type LookbackBlock = { text: string; items: LookbackItem[]; agentTurns: number[]; developer: string[] };

/** `from`: the instruction file the quote was found in, filled by the gate rather than trusted from the model. */
export type Established = { source: 'turn' | 'instruction' | 'developer-reference' | 'none'; quote: string; turn?: number; from?: string };

/**
 * Dimensions defined by an expectation that existed before the agent acted. `other` is included because,
 * without it, the label model moved gated findings there (measured: 7 of 16).
 */
export const NEEDS_SOURCE: ReadonlySet<string> = new Set(['misread_intent', 'constraint_violation', 'other']);

/** Content terms an instruction quote must share with its finding to count as its source. */
const RELEVANT_TERMS = 2;

const PROMPT_MAX = 300;
const RECENT_PROMPTS = 10;
const INSTRUCTION_LINES = 8;
const STOP = new Set(['that', 'this', 'with', 'have', 'from', 'what', 'when', 'were', 'will', 'your', 'they', 'them', 'then', 'than', 'there', 'their', 'about', 'which', 'would', 'could', 'should', 'into', 'been', 'only', 'also', 'agent', 'developer']);

function terms(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? []).filter((w) => !STOP.has(w)));
}

function overlap(a: Set<string>, text: string): number {
  let n = 0;
  for (const w of terms(text)) if (a.has(w)) n += 1;
  return n;
}

/** Lines of an instruction file: one per bullet or sentence-sized line, markdown furniture stripped. */
function linesOf(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+\.|#+)\s*/, '').replace(/\*\*/g, '').trim())
    .filter((l) => l.length >= 12);
}

const lineCache = new Map<string, string[]>();
function cachedLines(text: string): string[] {
  let v = lineCache.get(text);
  if (v === undefined) {
    v = linesOf(text);
    lineCache.set(text, v);
  }
  return v;
}

/** Normalised for quote matching: whitespace collapsed, quotes and case ignored. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[“”"'`]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * The block for one session: earlier prompts (the most recent, plus the most relevant) and the instruction
 * lines in force that best match `query`, within `budgetChars`. `uptoSeq` is the episode's last cited turn:
 * the expectation may be in the very prompt that set the task, so long as the agent acted after it.
 */
export function buildLookback(src: LookbackSource, query: string, uptoSeq: number, budgetChars: number, agentTurns: number[] = []): LookbackBlock {
  const q = terms(query);
  const earlier = src.prompts.filter((p) => p.seq <= uptoSeq);
  const seen = new Set<string>();
  const unique = earlier.filter((p) => {
    const k = norm(p.text);
    if (k === '' || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const recent = new Set(unique.slice(-RECENT_PROMPTS).map((p) => p.seq));
  const relevant = unique
    .filter((p) => !recent.has(p.seq))
    .map((p) => ({ p, s: overlap(q, p.text) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  const instr = src.instructions
    .filter((i) => i.fromSeq <= uptoSeq)
    .flatMap((i) => cachedLines(i.text).map((text) => ({ source: i.source, fromSeq: i.fromSeq, text, s: overlap(q, text) })))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, INSTRUCTION_LINES);

  const items: LookbackItem[] = [];
  let used = 0;
  const fits = (n: number): boolean => used + n <= budgetChars;
  // Instructions first: few, and the strongest kind of source.
  for (const x of instr) {
    const text = x.text.length <= PROMPT_MAX ? x.text : cleanCut(x.text.slice(0, PROMPT_MAX));
    if (!fits(text.length + 20)) break;
    used += text.length + 20;
    items.push({ kind: 'instruction', source: x.source, fromSeq: x.fromSeq, text });
  }
  for (const p of [...relevant.map((x) => x.p), ...unique.filter((p) => recent.has(p.seq)).reverse()]) {
    const text = p.text.length <= PROMPT_MAX ? p.text : cleanCut(p.text.slice(0, PROMPT_MAX));
    if (!fits(text.length + 20)) break;
    if (items.some((i) => i.kind === 'turn' && i.seq === p.seq)) continue;
    used += text.length + 20;
    items.push({ kind: 'turn', seq: p.seq, text });
  }

  const turns = items.filter((i): i is Extract<LookbackItem, { kind: 'turn' }> => i.kind === 'turn').sort((a, b) => a.seq - b.seq);
  const rules = items.filter((i): i is Extract<LookbackItem, { kind: 'instruction' }> => i.kind === 'instruction');
  const lines: string[] = [];
  if (turns.length > 0) lines.push('Earlier, the developer said:', ...turns.map((t) => `  turn ${t.seq}: "${t.text}"`));
  if (rules.length > 0) lines.push('Project instructions in force:', ...rules.map((r) => `  [${r.source}] ${r.text}`));
  return { text: lines.join('\n'), items: [...turns, ...rules], agentTurns, developer: earlier.map((p) => norm(p.text)) };
}

/** Why a finding that needs a source has none worth keeping; undefined when it stands. */
export function checkEstablished(est: Established | undefined, block: LookbackBlock | undefined, episode: JudgeEpisode): string | undefined {
  if (est === undefined || est.source === 'none') return 'no earlier source: a suggestion, not a mistake';
  const quote = norm(est.quote);
  if (quote.length < 8) return 'source quote too short to check';
  const last = Math.max(...episode.evidence.flatMap((v) => v.turns));
  // The agent must have acted after the source and within the episode, or nothing was missed.
  const actedAfter = (seq: number): boolean => (block?.agentTurns ?? []).some((t) => t > seq && t <= last);
  if (est.source === 'developer-reference') {
    // The developer's own words, not the agent's.
    return (block?.developer ?? []).some((d) => d.includes(quote)) ? undefined : 'developer reference is not something the developer said';
  }
  const hit = (block?.items ?? []).find((i) => i.kind === (est.source === 'turn' ? 'turn' : 'instruction') && norm(i.text).includes(quote));
  if (hit === undefined) return `${est.source} source not found in what was sent`;
  if (hit.kind === 'turn' && !actedAfter(hit.seq)) return 'the agent did not act after that source';
  if (hit.kind === 'instruction' && !actedAfter(hit.fromSeq)) return 'the agent did not act after that instruction loaded';
  if (hit.kind === 'instruction' && overlap(terms(episodeText(episode)), hit.text) < RELEVANT_TERMS) return 'instruction shares too little with the finding';
  return undefined;
}

/** A verified source with its origin taken from what was sent: the instruction's file, or the prompt's turn. */
export function withOrigin(est: Established, block: LookbackBlock | undefined): Established {
  const quote = norm(est.quote);
  const hit = (block?.items ?? []).find((i) => i.kind === (est.source === 'turn' ? 'turn' : 'instruction') && norm(i.text).includes(quote));
  if (hit?.kind === 'instruction') return { ...est, from: hit.source };
  if (hit?.kind === 'turn') return { ...est, turn: hit.seq };
  return est;
}

/**
 * Whether surfaces show the source. Off: on 2026-10-26 about half the verified citations were real but
 * beside the point (lookback-eval --all), and a wrong source shown as evidence is worse than none.
 */
export const SHOW_ESTABLISHED = false;

/** One line for every surface: where the expectation was set. */
export function establishedLine(est: Established): string {
  const where =
    est.source === 'instruction' ? (est.from ?? 'project instructions')
    : est.source === 'turn' ? (est.turn === undefined ? 'an earlier prompt' : `turn ${est.turn}`)
    : 'you, referring to an earlier decision';
  return `${where} — “${est.quote}”`;
}

function episodeText(e: JudgeEpisode): string {
  return [e.name, e.description, ...e.evidence.map((v) => `${v.quote} ${v.context}`)].join(' ');
}
