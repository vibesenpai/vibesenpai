/** Did an applied fix land, and did its dimension recur: counts per project, never a rate. Pure. */

import { createHash } from 'node:crypto';
import type { Event } from './types.ts';
import type { ApplyPlan } from './fix.ts';
import type { FixSighting } from './store.ts';
import { spanOf } from './render.ts';

/** Content-free key for one of our own rule lines. */
export function ruleHash(rule: string): string {
  return createHash('sha256').update(rule.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);
}

/** A loaded instruction, as any harness's parser reports it. */
type Loaded = { fromSeq: number; text: string };

/** The fixes a session applied (their marker) and the rules it loaded, as store rows. */
export function sightingsIn(
  sessionId: string,
  project: string,
  events: readonly Event[],
  loaded: readonly Loaded[],
  rules: readonly string[],
): { applied: FixSighting[]; loaded: FixSighting[] } {
  const tsOf = new Map(events.map((e) => [e.seq, e.ts]));
  const first = spanOf([...events]).first;
  // Loaded before the agent's first reply is loaded at the start: dated as the session's start.
  const replied = Math.min(...events.filter((e) => e.turnType === 'assistant_msg').map((e) => e.seq));
  const applied = events.flatMap((e) =>
    e.fixApplied === undefined || e.ts === undefined ? [] : e.fixApplied.map((key) => ({ key, project, sessionId, at: e.ts as string })),
  );
  const flat = (t: string): string => t.replace(/\s+/g, ' ');
  const seen = new Map<string, string>();
  for (const l of loaded) {
    const at = l.fromSeq < replied ? first : tsOf.get(l.fromSeq) ?? first;
    if (at === undefined) continue;
    for (const r of rules) if (!seen.has(r) && flat(l.text).includes(flat(r).trim())) seen.set(r, at);
  }
  return { applied, loaded: [...seen].map(([r, at]) => ({ key: ruleHash(r), project, sessionId, at })) };
}

/** One session as the outcome needs it: when, whether the judge read it, what it showed. */
export type OutcomeSession = {
  id: string;
  project: string;
  at?: string;
  judged: boolean;
  /** Occurrences per dimension, and the first cited turn of each. */
  found: Record<string, { times: number; turn?: number }>;
  /** Occurrences per finding-fix key (`action:git push`), so a keyed fix counts its own constraint. */
  keys?: Record<string, { times: number; turn?: number }>;
};

export type Window = { times: number; sessions: number };

export type FixState = ApplyPlan & {
  applied?: { at: string; sessionId: string };
  /** What the windows count: the fix's own constraint, or only its dimension (a `quote:` key cannot be matched). */
  counts?: 'same-fix' | 'same-kind';
  /** The rule was seen loaded after it was requested. False: requested, never loaded, so no counts yet. */
  inEffect?: boolean;
  before?: Window;
  since?: Window;
  /** The first occurrence after it was applied. */
  cameBack?: { sessionId: string; turn?: number };
};

/**
 * Each plan's state in one project. The denominator follows the method: a model dimension counts only
 * sessions the judge read, a rule dimension every analysed session.
 */
export function fixStates(
  plans: ApplyPlan[],
  applied: FixSighting[],
  loaded: FixSighting[],
  sessions: OutcomeSession[],
  project: string,
  byModel: (dimension: string) => boolean,
): FixState[] {
  const here = sessions.filter((s) => s.project === project && s.at !== undefined).sort((a, b) => (a.at as string).localeCompare(b.at as string));
  return plans.map((p) => {
    const a = applied.filter((x) => x.key === p.fixId && x.project === project).sort((x, y) => x.at.localeCompare(y.at))[0];
    if (a === undefined) return p;
    // A rule counts from when it was first seen loaded: a request the developer declined never took effect.
    const rule = p.target === 'project-instructions' || p.target === 'scoped-instructions';
    const load = loaded.filter((l) => l.key === ruleHash(p.text) && l.project === project && l.at >= a.at).sort((x, y) => x.at.localeCompare(y.at))[0];
    if (rule && load === undefined) return { ...p, applied: { at: a.at, sessionId: a.sessionId }, inEffect: false };
    const from = load?.at ?? a.at;
    const pool = here.filter((s) => !byModel(p.dimension) || s.judged);
    const keyed = p.key !== undefined && !p.key.startsWith('quote:');
    const hit = (s: OutcomeSession): { times: number; turn?: number } | undefined => (keyed ? s.keys?.[p.key as string] : s.found[p.dimension]);
    const count = (ss: OutcomeSession[]): Window => ({ times: ss.reduce((n, s) => n + (hit(s)?.times ?? 0), 0), sessions: ss.length });
    // The applying session, and a session the rule first loaded into mid-way, are part before and part after.
    const loadedMidway = load !== undefined && (here.find((s) => s.id === load.sessionId)?.at ?? load.at) < load.at;
    const mixed = new Set([a.sessionId, ...(loadedMidway ? [load.sessionId] : [])]);
    const others = pool.filter((s) => !mixed.has(s.id));
    const after = others.filter((s) => (s.at as string) >= from);
    const back = after.find((s) => (hit(s)?.times ?? 0) > 0);
    const turn = back === undefined ? undefined : hit(back)?.turn;
    return {
      ...p,
      applied: { at: a.at, sessionId: a.sessionId },
      ...(p.key !== undefined ? { counts: keyed ? ('same-fix' as const) : ('same-kind' as const) } : {}),
      ...(rule ? { inEffect: true } : {}),
      before: count(others.filter((s) => !after.includes(s))),
      since: count(after),
      ...(back !== undefined ? { cameBack: { sessionId: back.id, ...(turn !== undefined ? { turn } : {}) } } : {}),
    };
  });
}
