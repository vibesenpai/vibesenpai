/**
 * `revert_churn` — work is discarded.
 *
 * `RULE` · conf `certain` · **neutral** · core
 *
 * ── Why the polarity is neutral, not lower-is-better ─────────────────────────
 *
 * The *event* is certain: a destructive git command ran, or the harness restored
 * a file from its backup. The *interpretation* is not. Throwing away a
 * deliberate spike is good engineering; so is resetting a branch that went the
 * wrong way. Scoring this as a failure would punish exactly the instinct the
 * tool should encourage.
 *
 * So it is reported as a fact — "work discarded" — and its value comes from
 * pairing with `rework_loop` in M2b, where the question becomes whether the
 * discarded work had to be done twice.
 *
 * ── The precision guard ─────────────────────────────────────────────────────
 *
 * The command must affect files **this session edited**. `git reset --hard` in a
 * session that touched nothing is somebody tidying their tree before starting,
 * and reporting it as discarded work would be wrong on the plain meaning of the
 * words. Where the command names no path, a session-edit requirement still
 * applies: no edits, no churn.
 */

import { EDIT_TOOLS } from './index.ts';
import { executablePart } from './command.ts';
import type { Candidate } from '../finding.ts';
import type { Event, TurnRef } from '../types.ts';
import type { Detector, DetectorContext } from './types.ts';


/**
 * Destructive git operations. Each discards uncommitted or committed work
 * without asking — which is what separates them from `git checkout <branch>`.
 */
const DESTRUCTIVE: { re: RegExp; what: string }[] = [
  { re: /\bgit\s+(?:-\S+\s+)*checkout\s+--\s/, what: 'git checkout --' },
  { re: /\bgit\s+(?:-\S+\s+)*restore\b/, what: 'git restore' },
  { re: /\bgit\s+(?:-\S+\s+)*reset\s+--hard\b/, what: 'git reset --hard' },
  { re: /\bgit\s+(?:-\S+\s+)*stash\s+drop\b/, what: 'git stash drop' },
  { re: /\bgit\s+(?:-\S+\s+)*clean\s+-\S*f/, what: 'git clean -f' },
];

export function destructiveKind(command: string | undefined): string | undefined {
  if (command === undefined) return undefined;
  // Heredoc bodies are data, not commands. The first real finding this detector
  // produced was `git reset --hard` inside a doc file being written with `cat`.
  const exec = executablePart(command);
  if (exec.trim() === '') return undefined;
  for (const d of DESTRUCTIVE) if (d.re.test(exec)) return d.what;
  return undefined;
}

/** Files this window's events edited, in order. */
function editedFiles(events: Event[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.turnType !== 'tool_use') continue;
    if (!EDIT_TOOLS.has(e.toolName ?? '')) continue;
    if (e.filePath !== undefined) out.push(e.filePath);
  }
  return out;
}

export function revertChurn(): Detector {
  return {
    dimension: 'revert_churn',
    // Session: a subagent may edit the files that the main thread then resets.
    // Per-thread, neither half would see the other.
    scope: 'session',
    polarity: 'neutral',
    confidence: 'certain',
    method: 'RULE',
    requiresOutcome: false,
    denominator: 'per-session',
    preset: 'core',

    describe(subject, occurrences) {
      return occurrences === 1
        ? `work discarded by ${subject}`
        : `work discarded ${occurrences}× by ${subject}`;
    },

    async detect(ctx: DetectorContext): Promise<Candidate[]> {
      const events = [...ctx.events].sort((a, b) => a.seq - b.seq);
      const edited = editedFiles(events);

      // No edits anywhere in the session means nothing of this session's work
      // was at risk — the command was housekeeping, not churn.
      if (edited.length === 0) return [];

      const bySubject = new Map<string, TurnRef[]>();

      for (const e of events) {
        if (e.turnType !== 'tool_use') continue;
        const kind = destructiveKind(e.command);
        if (kind === undefined) continue;

        // Restoration recorded by the harness itself, rather than inferred from
        // a command, would also land here once `file-history` records carry the
        // restored path. They do not yet, so this is command-driven only — and
        // saying so beats implying coverage we lack.
        const refs = bySubject.get(kind) ?? [];
        refs.push({ uuid: e.uuid, sessionId: e.sessionId, seq: e.seq });
        bySubject.set(kind, refs);
      }

      return [...bySubject].map(([subject, evidence]) => ({
        dimension: 'revert_churn',
        subject,
        evidence,
        confidence: 'certain' as const,
        method: 'RULE' as const,
        polarity: 'neutral' as const,
        requiresOutcome: false,
        artifacts: [],
      }));
    },
  };
}
