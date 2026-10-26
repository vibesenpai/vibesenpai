/**
 * Session metadata: facts reported beside findings, never findings or scores.
 * Edit counts inform rather than filter (shell edits bypass edit tools). Why: GRAVEYARD.md `file_churn`, DECISIONS.md D66.
 */

import { EDIT_TOOLS } from './detect/tools.ts';
import { oncePerResponse } from './normalise.ts';
import type { Event } from './types.ts';

/** Prefix size before its loss counts as a rebuild; early turns swing legitimately. */
const REBUILD_FLOOR = 20_000;

type RewrittenFile = {
  path: string;
  /** Version increments the harness recorded — tool-agnostic, so it counts everything. */
  versions: number;
  /** `Edit`-family calls on this path. Undercounts: shell edits make no edit-tool call. */
  editCalls: number;
};

/** One rebuild: the request that found nothing to read, and what it wrote. */
export type Rebuild = {
  seq: number;
  uuid: string;
  /** Written again by this request. */
  tokens: number;
  /** What the previous request on this thread had read from cache — what was lost. */
  cached: number;
  /** Since the previous request on this thread. Absent when either has no timestamp. */
  gapMinutes?: number;
};

export type SessionStats = {
  /** Files the harness saw change most, biggest first. Ordered, not thresholded. */
  rewritten: RewrittenFile[];
  /** Compactions, from the harness's own figures. Metadata, not a finding. */
  compactions: {
    /** Every compaction, including the older record shape that carries no counts. */
    count: number;
    /** Summed `preTokens - postTokens`, over those that reported both. */
    dropped: number;
    /** Those that reported counts. Fewer than `count` on older transcripts. */
    measured: { seq: number; preTokens: number; postTokens: number }[];
  };
  /**
   * Where the prompt cache collapsed from its running level and was written again. Compared
   * per thread, excluding compactions; flagged, not a finding. See DECISIONS.md D66.
   */
  rebuilds: {
    /** How many times the prefix was rebuilt. */
    count: number;
    /** Tokens written by those rebuilds. */
    tokens: number;
    /** Their share of everything this session wrote to cache, 0-1. */
    share: number;
    /** Each one, in transcript order. */
    events: Rebuild[];
  };
};

/** Does `a` and `b` name the same file, allowing for one being repo-relative? */
function samePath(a: string, b: string): boolean {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

export function sessionStats(events: Event[]): SessionStats {
  const versions = new Map<string, number>();
  const editsByPath = new Map<string, number>();
  const compactions: { seq: number; preTokens: number; postTokens: number }[] = [];
  let compactionCount = 0;
  // Count usage once per response, among cache-creation-bearing events.
  const countOnce = new Set(
    oncePerResponse(events.filter((e) => (e.tokens?.cacheCreation ?? 0) > 0)),
  );

  for (const e of events) {
    // `changedFiles` holds only version increases; the parser owns that.
    for (const path of e.changedFiles ?? []) {
      versions.set(path, (versions.get(path) ?? 0) + 1);
    }

    if (e.turnType === 'tool_use' && EDIT_TOOLS.has(e.toolName ?? '') && e.filePath !== undefined) {
      editsByPath.set(e.filePath, (editsByPath.get(e.filePath) ?? 0) + 1);
    }

    if (e.systemKind === 'compaction') {
      // Counted even without figures (the older `summary` shape has none).
      compactionCount++;
      if (e.compaction !== undefined) compactions.push({ seq: e.seq, ...e.compaction });
    }
  }

  const editsFor = (harnessPath: string): number => {
    for (const [toolPath, n] of editsByPath) if (samePath(toolPath, harnessPath)) return n;
    return 0;
  };

  const rewritten: RewrittenFile[] = [...versions]
    .map(([path, n]) => ({ path, versions: n, editCalls: editsFor(path) }))
    .sort((a, b) => b.versions - a.versions || b.editCalls - a.editCalls);

  // Rebuilds, in transcript order, over responses (not records) via `countOnce`.
  const rebuilt: Rebuild[] = [];
  let written = 0;
  const last = new Map<string, Event>();
  const compactedSince = new Set<string>();
  for (const e of events) {
    const actor = e.sidechainId ?? 'main';
    if (e.systemKind === 'compaction') compactedSince.add(actor);
    if (!countOnce.has(e)) continue;
    const created = e.tokens?.cacheCreation ?? 0;
    written += created;
    const read = e.tokens?.cacheRead ?? 0;
    const prev = last.get(actor);
    const prevRead = prev?.tokens?.cacheRead ?? 0;
    // A prefix that had been accumulating, and then was not there to read.
    if (prevRead > REBUILD_FLOOR && read < prevRead / 2 && created > 0 && !compactedSince.has(actor)) {
      const gap = prev?.ts !== undefined && e.ts !== undefined ? (Date.parse(e.ts) - Date.parse(prev.ts)) / 60_000 : NaN;
      rebuilt.push({
        seq: e.seq,
        uuid: e.uuid,
        tokens: created,
        cached: prevRead,
        ...(Number.isFinite(gap) ? { gapMinutes: gap } : {}),
      });
    }
    last.set(actor, e);
    compactedSince.delete(actor);
  }
  const rebuildTokens = rebuilt.reduce((n, r) => n + r.tokens, 0);

  return {
    rewritten,
    compactions: {
      count: compactionCount,
      // `preTokens` is the context at that moment, not a running total, so no double count.
      dropped: compactions.reduce((n, c) => n + Math.max(0, c.preTokens - c.postTokens), 0),
      measured: compactions,
    },
    rebuilds: {
      count: rebuilt.length,
      tokens: rebuildTokens,
      share: written === 0 ? 0 : rebuildTokens / written,
      events: rebuilt,
    },
  };
}
