// "Did a file change?", shared by the detectors, stats and measurement.

import type { Event } from '../types.ts';

// Claude Code's own writers. A closed, published list, so an allowlist is legitimate.
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Read-only tools. Needed because `Read` also carries a `filePath`.
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);

export type EditEvidence =
  /** A Claude-owned writer. Closed list, authoritative. */
  | 'tool'
  /** The harness recorded the file's version rising. Tool-agnostic. */
  | 'harness'
  /** Carries a path, is not a known reader — probable, not proven. */
  | 'probable';

/**
 * How we know a file changed, strongest first, or `undefined` with no evidence.
 * `harness` needs file-history snapshots (harness 2.1+); `probable` is never a confirmed edit.
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
