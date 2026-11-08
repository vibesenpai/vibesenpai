/** A finding's fix as the CLI and the report show it. Apart from claude-code.ts, which the pane imports: this needs node:crypto. */

import { stopHookSnippet } from '../fix.ts';
import { findingPlan, type FindingFix } from '../finding-fix.ts';
import { destination, LOCAL_SETTINGS, snippetFor } from './claude-code.ts';

/** Where a finding's fix lands, and the text to read or copy. */
export function fixDisplay(x: FindingFix): { destination: string; body: string } {
  const p = findingPlan(x);
  if (p === undefined) return { destination: LOCAL_SETTINGS, body: stopHookSnippet() };
  return { destination: destination(p), body: p.target === 'project-check' ? p.text : snippetFor(p) ?? p.text };
}
