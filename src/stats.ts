/**
 * Session metadata — facts with no accusation attached.
 *
 * ── Why these are not findings ──────────────────────────────────────────────
 *
 * A finding needs a turn to point at *and* a claim worth making. These have the
 * first and not the second, and both were measured rather than assumed:
 *
 * **File churn.** Correlation with edit friction is 15% against a 9% base rate
 * — barely a signal — and of the 91 highest-churn paths in the corpus, 30 are
 * never touched by `Edit` at all: `.continue-here.md` at 27 versions,
 * `.planning/HANDOFF.json` at 27, `69-UAT.md` at 19. Those are files whose
 * purpose is to be rewritten. Reporting them as waste would be wrong in the
 * same way `revert_churn` was wrong about a preserved branch.
 *
 * ── Why the edit count does not filter, only inform ────────────────────────
 *
 * "No `Edit` calls means the file was regenerated" was the plan, and it is
 * wrong. **An agent that edits through `Bash` — a `python3` heredoc, `sed` —
 * produces version increments with no edit-tool call at all.** Measured on a
 * real local session: `src/archive.ts` at **51 versions and 1 edit call**, which
 * was heavy genuine editing done through a shell. Filtering on that would have
 * hidden the most-worked file in the session.
 *
 * So both numbers are reported and neither decides. A reader seeing
 * `HANDOFF.json 27 versions (0 edit calls)` beside `server.ts 18 versions
 * (59 edit calls)` can tell those apart; a filter that guessed for them could
 * not. Evidence, not a verdict.
 *
 * **Context re-ingestion.** A session-wide ratio has no turn to anchor to. But
 * it *is* concentrated — measured, half a session's re-ingestion comes from 6%
 * of its turns (p50; p10 is 1.3%) — so the heaviest turns are nameable, and a
 * ranking needs no threshold.
 *
 * So both are reported as context a reader uses to interpret findings, never as
 * findings themselves and never as a score. That is the line CLAUDE.md draws
 * with "two outputs, never a third".
 */

import { EDIT_TOOLS } from './edits.ts';
import { oncePerResponse } from './normalise.ts';
import type { Event } from './types.ts';

/** How many of the heaviest re-ingestion turns to name. A ranking, not a cut-off. */
export const HEAVIEST_TURNS = 3;

/**
 * How much prefix must have accumulated before its loss counts as a rebuild.
 *
 * Below this a session has barely begun caching, and the opening turns swing
 * legitimately between nothing and something — the same setup write that made
 * a one-minute session report a re-read ratio of 133.
 */
const REBUILD_FLOOR = 20_000;

export type RewrittenFile = {
  path: string;
  /** Version increments the harness recorded — tool-agnostic, so it counts everything. */
  versions: number;
  /**
   * `Edit`-family tool calls against this path.
   *
   * **Undercounts by design.** A shell-driven edit (`python3` heredoc, `sed`)
   * changes the file without any edit-tool call, so a low number here next to a
   * high `versions` means "changed another way", never "not really changed".
   */
  editCalls: number;
};

export type ReingestTurn = { seq: number; uuid: string; tokens: number };

export type SessionStats = {
  /**
   * Files the harness saw change most, biggest first.
   *
   * Ordered, not thresholded, and nothing is excluded — see the note above on
   * why the edit count informs rather than filters.
   */
  rewritten: RewrittenFile[];
  reingest: {
    total: number;
    /** The heaviest turns, biggest first. */
    heaviest: ReingestTurn[];
    /** What share of the session's re-ingestion those turns account for, 0–1. */
    share: number;
  };
  /**
   * Where the session hit the context limit and was summarised.
   *
   * **Metadata, not a finding**, and the distinction is the point. A finding
   * says something could have gone better and carries something applicable; a
   * compaction is a fact about how long the session ran, and the honest
   * response to it — start a fresh session — is advice, which CLAUDE.md puts
   * out of scope. So this sits beside SESSION COST and states what happened.
   *
   * Reported because the figures are the harness's own and are large: one real
   * session dropped 2,843,171 tokens across three compactions. Nothing here is
   * inferred.
   */
  compactions: {
    /** Every compaction, including the older record shape that carries no counts. */
    count: number;
    /** Summed `preTokens - postTokens`, over those that reported both. */
    dropped: number;
    /** Those that reported counts. Fewer than `count` on older transcripts. */
    measured: { seq: number; preTokens: number; postTokens: number }[];
  };
  /**
   * Where the prompt cache was thrown away and written again from nothing.
   *
   * ── The one legitimate use of `cacheRead` ────────────────────────────────
   *
   * `cacheRead` cannot be divided: it re-counts the entire prefix on every
   * call, so any ratio built on it is pinned near 1 by construction, and
   * GRAVEYARD.md records cache hit rate dying on exactly that — p10 0.901 to
   * p90 0.985. What it *can* do is be compared against itself. A rebuild is
   * the one event where it **collapses** from its own running level while
   * `cacheCreation` fires, and that is a change rather than a ratio.
   *
   * A large write alone proves nothing: reading a big file legitimately adds
   * to the prefix, and is the cache working. What marks a rebuild is that
   * there was nothing left to read from.
   *
   * **Metadata, not a finding**, for the same reason as `compactions` above.
   * The price is real — a write costs 1.25x base against 0.10x for a read —
   * and the only thing a reader could do about it is work in shorter
   * sessions, which CLAUDE.md puts out of scope. So this states the figure
   * and stops there.
   *
   * Measured across the three largest real sessions, 2026-10-24:
   *
   * ```
   *   46b591a1   15 rebuilds   6,151,009 of  9,394,443   65%
   *   e3a3f0d4   21 rebuilds   9,576,876 of 13,416,140   71%
   *   28815e56    4 rebuilds     902,871 of  1,202,050   75%
   * ```
   *
   * **Two thirds of what a long session writes to cache is rewriting what was
   * already there**, and it is concentrated: 15 events out of 2,252 carry it,
   * because a rebuild rewrites the entire prefix where ordinary growth adds a
   * few thousand tokens. The worst re-cached 797,275 after a 70-minute gap.
   *
   * A first pass at this put the share at 25%, by summing `cacheCreation`
   * over **records** rather than responses — the exact overcount
   * `oncePerResponse` exists to prevent, inflating the denominator 2.61x.
   */
  rebuilds: {
    /** How many times the prefix was rebuilt. */
    count: number;
    /** Tokens written by those rebuilds. */
    tokens: number;
    /** Their share of everything this session wrote to cache, 0-1. */
    share: number;
  };
};

/** Does `a` and `b` name the same file, allowing for one being repo-relative? */
function samePath(a: string, b: string): boolean {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

export function sessionStats(events: Event[]): SessionStats {
  const versions = new Map<string, number>();
  const editsByPath = new Map<string, number>();
  const reingest: ReingestTurn[] = [];
  const compactions: { seq: number; preTokens: number; postTokens: number }[] = [];
  let compactionCount = 0;
  // Among cache-creation-bearing events only, for the reason `index.ts` gives.
  const countOnce = new Set(
    oncePerResponse(events.filter((e) => (e.tokens?.cacheCreation ?? 0) > 0)),
  );

  for (const e of events) {
    // `changedFiles` already holds only paths whose version *increased*, so a
    // first sighting at version 1 — the snapshot being established — is not
    // counted as a change. The parser owns that.
    for (const path of e.changedFiles ?? []) {
      versions.set(path, (versions.get(path) ?? 0) + 1);
    }

    if (e.turnType === 'tool_use' && EDIT_TOOLS.has(e.toolName ?? '') && e.filePath !== undefined) {
      editsByPath.set(e.filePath, (editsByPath.get(e.filePath) ?? 0) + 1);
    }

    if (e.systemKind === 'compaction') {
      // Counted whether or not it carries figures: the older `summary` record
      // shape has none, and reporting two compactions as one would be worse
      // than reporting one without its numbers.
      compactionCount++;
      if (e.compaction !== undefined) compactions.push({ seq: e.seq, ...e.compaction });
    }

    // Once per response. A response spans several records carrying the same
    // `usage`, so counting per record ranked one response as three consecutive
    // "heaviest turns" — which is exactly how the bug showed itself: three
    // adjacent seqs whose share did not budge when the totals were halved.
    const created = countOnce.has(e) ? (e.tokens?.cacheCreation ?? 0) : 0;
    if (created > 0) reingest.push({ seq: e.seq, uuid: e.uuid, tokens: created });
  }

  const editsFor = (harnessPath: string): number => {
    for (const [toolPath, n] of editsByPath) if (samePath(toolPath, harnessPath)) return n;
    return 0;
  };

  const rewritten: RewrittenFile[] = [...versions]
    .map(([path, n]) => ({ path, versions: n, editCalls: editsFor(path) }))
    .sort((a, b) => b.versions - a.versions || b.editCalls - a.editCalls);

  // ── Rebuilds, walked in transcript order ────────────────────────────────
  //
  // Over responses rather than records, for the reason `countOnce` exists: a
  // response spans several records carrying the same `usage`, so a per-record
  // walk would see one rebuild three times — the same bug that once ranked
  // three adjacent seqs as the three heaviest turns.
  const responses = events.filter((e) => countOnce.has(e));
  let rebuildCount = 0;
  let rebuildTokens = 0;
  let written = 0;
  for (const [i, e] of responses.entries()) {
    const created = e.tokens?.cacheCreation ?? 0;
    written += created;
    const read = e.tokens?.cacheRead ?? 0;
    const prev = responses[i - 1]?.tokens?.cacheRead ?? 0;
    // A prefix that had been accumulating, and then was not there to read.
    if (prev > REBUILD_FLOOR && read < prev / 2 && created > 0) {
      rebuildCount += 1;
      rebuildTokens += created;
    }
  }

  reingest.sort((a, b) => b.tokens - a.tokens);
  const total = reingest.reduce((n, t) => n + t.tokens, 0);
  const heaviest = reingest.slice(0, HEAVIEST_TURNS);
  const share = total === 0 ? 0 : heaviest.reduce((n, t) => n + t.tokens, 0) / total;

  return {
    rewritten,
    reingest: { total, heaviest, share },
    compactions: {
      count: compactionCount,
      // Each compaction's own before/after. A compaction is bounded by the one
      // before it, so these do not double-count: `preTokens` is the context at
      // that moment, not a running total.
      dropped: compactions.reduce((n, c) => n + Math.max(0, c.preTokens - c.postTokens), 0),
      measured: compactions,
    },
    rebuilds: {
      count: rebuildCount,
      tokens: rebuildTokens,
      share: written === 0 ? 0 : rebuildTokens / written,
    },
  };
}
