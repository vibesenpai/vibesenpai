/** The conversation around a finding's cited turns, read from the transcript in place and redacted. Pure. */

import { buildTurns, cleanCut, truncate } from './judge/packet.ts';
import { redact } from './redact.ts';
import type { Event } from './types.ts';

export type ExcerptEntry = {
  role: 'developer' | 'agent';
  /** When its first message was written. */
  at?: string;
  /** Holds a turn the finding cites. */
  cited: boolean;
  text: string;
  /** One line per tool call: `Edit src/a.ts`, `Bash npm test · failed`. */
  tools: string[];
};

/** Runs of entries; a gap lies between consecutive ones. */
export type Excerpt = { kept: true; parts: ExcerptEntry[][]; moreBefore: boolean; moreAfter: boolean } | { kept: false };

/** Per message, not per entry: the pane clips further. */
const TEXT_MAX = 800;
const TOOL_MAX = 120;

// Redacted before the cut, so a cut never hides a secret from the redactor; and after, as the gate does.
const clean = (s: string, max: number): string => redact(truncate(redact(s).text, max)).text;
/** A tool call's first line, cut short. */
const oneLine = (s: string): string => {
  const line = redact(s).text.split('\n')[0]!.trim();
  return redact(line.length <= TOOL_MAX ? line : `${cleanCut(line.slice(0, TOOL_MAX)).trimEnd()} …`).text;
};

/** `around` merged turns either side of each cited one; overlapping windows join. */
export function excerptOf(events: Event[], full: Map<number, string>, turns: number[], around: number): Excerpt {
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const merged = buildTurns(events, full);
  if (merged.length === 0) return { kept: true, parts: [], moreBefore: false, moreAfter: false };

  // A cited seq the packet dropped (a tool result, noise) belongs to the last turn at or before it.
  const indexOf = (seq: number): number => {
    let hit = 0;
    for (let i = 0; i < merged.length; i++) if (merged[i]!.seqs[0]! <= seq) hit = i;
    return hit;
  };
  const cited = new Set(turns.map(indexOf));
  const ranges = [...cited].sort((a, b) => a - b).map((i) => [Math.max(0, i - around), Math.min(merged.length - 1, i + around)] as [number, number]);
  const joined: [number, number][] = [];
  for (const r of ranges) {
    const last = joined[joined.length - 1];
    if (last !== undefined && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else joined.push([...r]);
  }

  const entry = (i: number): ExcerptEntry => {
    const t = merged[i]!;
    const texts: string[] = [];
    const tools: string[] = [];
    for (const p of t.parts) {
      const e = bySeq.get(p.seq);
      if (e === undefined || e.devCommand?.part === 'instructions') continue;
      if (e.turnType === 'tool_use') {
        tools.push(oneLine(`${e.toolName ?? 'tool'} ${e.filePath ?? e.pattern ?? e.command ?? ''}`));
      } else if (e.turnType === 'tool_result') {
        if (e.isError === true && tools.length > 0) tools[tools.length - 1] += ' · failed';
      } else texts.push(p.text);
    }
    const at = bySeq.get(t.seqs[0]!)?.ts;
    return {
      role: t.role === 'USER' ? 'developer' : 'agent',
      ...(at !== undefined ? { at } : {}),
      cited: cited.has(i),
      text: clean(texts.join('\n\n'), TEXT_MAX),
      tools,
    };
  };

  return {
    kept: true,
    parts: joined.map(([a, b]) => Array.from({ length: b - a + 1 }, (_, k) => entry(a + k)).filter((e) => e.text !== '' || e.tools.length > 0)),
    moreBefore: joined[0]![0] > 0,
    moreAfter: joined[joined.length - 1]![1] < merged.length - 1,
  };
}
