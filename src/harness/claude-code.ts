/** Claude Code's half of applying a fix: where each target lives, and the request the agent is asked to carry out. */

import type { ApplyPlan } from '../fix.ts';
import { fixMarker } from '../fix-marker.ts';

/** Ours alone: the user's CLAUDE.md only ever gains one pointer line to it. */
export const RULES_FILE = '.claude/rules/agentsensei.md';
export const POINTER = `- Rules learned from your own sessions: ${RULES_FILE}`;

/** The project key Claude Code files a working directory's transcripts under. */
export function projectKey(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Where a plan's change lands, as the pane names it. */
export function destination(p: ApplyPlan): string {
  return p.target === 'session' ? 'this session only' : p.target === 'project-hooks' ? '.claude/settings.local.json' : RULES_FILE;
}

/** One prompt for any number of plans, ending with the marker that dates them. */
export function applyRequest(plans: ApplyPlan[]): string {
  const rules = plans.filter((p) => p.target === 'project-instructions').map((p) => p.text);
  const session = plans.filter((p) => p.target === 'session').map((p) => p.text);
  const parts: string[] = [];
  if (rules.length > 0) {
    const it = rules.length === 1 ? 'this line' : 'these lines';
    parts.push(
      `Add ${it} to ${RULES_FILE} (create the file if it is missing; skip a line already there):`,
      ...rules,
      `Then, if CLAUDE.md does not already point to that file, add this line to it:`,
      POINTER,
    );
  }
  if (session.length > 0) parts.push(...(parts.length > 0 ? [''] : []), ...session);
  parts.push(fixMarker(plans.map((p) => p.fixId)));
  return parts.join('\n');
}
