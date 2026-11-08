/** A finding's fix as the CLI and the report show it. Apart from claude-code.ts, which the pane imports: this needs node:crypto. */

import { stopHookSnippet } from '../fix.ts';
import { findingPlan, type FindingFix } from '../finding-fix.ts';
import { destination, LOCAL_SETTINGS, snippetFor } from './claude-code.ts';
import { projectLabel } from '../read.ts';

/** Where a finding's fix lands, and the text to read or copy. */
export function fixDisplay(x: FindingFix): { destination: string; body: string } {
  const p = findingPlan(x);
  if (p === undefined) return { destination: LOCAL_SETTINGS, body: stopHookSnippet() };
  return { destination: destination(p), body: p.target === 'project-check' ? p.text : snippetFor(p) ?? p.text };
}

/** Where a fix is applied, now that the pane is the only way to say yes (D70). */
export const APPLY_IN_PANE = 'To apply it: /vibesenpai:insights, then Apply under the finding or on the Fixes tab.';

/** Why there is nothing to apply here: a printed-only hook, or a fix for another project. */
export function applyRefusal(x: FindingFix, projects: string[]): string {
  return !x.applicable
    ? 'Printed only: a Stop hook can hold a turn open up to 8 times in a row.'
    : `This happened in ${projects.map(projectLabel).join(' and ')}. Apply it from a session there.`;
}

/** Where the change lands, as one sentence. */
export function whereLine(x: FindingFix, destination: string): string {
  return x.kind === 'check'
    ? 'The agent shows you the test before adding it.'
    : `Added to ${destination}${x.paths === undefined ? '' : `, for ${x.paths.join(', ')}`}`;
}
