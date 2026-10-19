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
};

/** Does `a` and `b` name the same file, allowing for one being repo-relative? */
function samePath(a: string, b: string): boolean {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

export function sessionStats(events: Event[]): SessionStats {
  const versions = new Map<string, number>();
  const editsByPath = new Map<string, number>();
  const reingest: ReingestTurn[] = [];

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

    const created = e.tokens?.cacheCreation ?? 0;
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

  return { rewritten, reingest: { total, heaviest, share } };
}
