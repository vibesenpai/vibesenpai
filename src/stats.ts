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
  };
}
