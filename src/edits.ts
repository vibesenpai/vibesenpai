/**
 * "Did a file change?" — three layers, no single tool-name list.
 *
 * Lives in its own module because both the detector runner and the verification
 * registry need it, and `src/verify.ts` cannot import from `src/detect/` — the
 * dependency already runs the other way.
 */

import type { Event } from './types.ts';

/**
 * Claude Code's own file-writing tools.
 *
 * A name allowlist, and a legitimate one: the space is **closed** — Anthropic
 * publishes these, there are four, and they change rarely. That is the test for
 * whether a list is acceptable. It is not the whole answer for "did a file
 * change?" in a world with MCP servers (see `fileTouches`), but it is the
 * authoritative layer, covering 789 of 794 file-writing calls measured.
 *
 * One definition: this previously existed as three separate copies.
 */
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Claude Code's own read-only tools.
 *
 * Also a closed, published, slow-moving space — and the reason path presence
 * alone cannot mean "edit": `Read` carries a `filePath` too, and so does
 * `mcp__acp__Read`.
 */
export const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);

export type EditEvidence =
  /** A Claude-owned writer. Closed list, authoritative. */
  | 'tool'
  /** The harness recorded the file's version rising. Tool-agnostic. */
  | 'harness'
  /** Carries a path, is not a known reader — probable, not proven. */
  | 'probable';

/**
 * Did a file change, and how do we know?
 *
 * Three layers, strongest first, because no single one covers the world:
 *
 * 1. `tool` — Claude's own edit tools. A legitimate allowlist: closed space,
 *    published by Anthropic, four entries, rarely changes. Covers 789 of 794
 *    file-writing calls measured.
 * 2. `harness` — `file-history-snapshot` version increases. Tool-agnostic, so
 *    it catches MCP writes and tools that do not exist yet. Version-gated
 *    though: absent before harness 2.1.
 * 3. `probable` — carries a path, is not a known reader. Cannot separate an
 *    unknown writer from an unknown reader, so it **demotes** rather than
 *    asserts: counted separately and never treated as a confirmed edit.
 *
 * This is the shape the allowlist rule demands: the closed list is authoritative
 * where it applies, behaviour covers the open remainder, and what neither can
 * decide is reported as undecided rather than guessed.
 */
export function editEvidenceOf(e: Event): EditEvidence | undefined {
  if (e.turnType === 'system' && (e.changedFiles?.length ?? 0) > 0) return 'harness';
  if (e.turnType !== 'tool_use') return undefined;
  const name = e.toolName ?? '';
  if (EDIT_TOOLS.has(name)) return 'tool';
  if (READ_TOOLS.has(name)) return undefined;
  if (e.filePath !== undefined) return 'probable';
  return undefined;
}
