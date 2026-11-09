/** Claude Code's half of applying a fix: where each target lives, and the request the agent is asked to carry out. */

import type { ApplyPlan } from '../fix.ts';
import { fixMarker } from '../fix-marker.ts';

/** Ours alone: the user's CLAUDE.md only ever gains one pointer line to it. */
export const RULES_FILE = '.claude/rules/vibesenpai.md';
export const POINTER = `- Rules learned from your own sessions: ${RULES_FILE}`;

/** The project key Claude Code files a working directory's transcripts under. */
export function projectKey(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Paths Claude Code writes for itself (plans, memory, transcripts, temp): never a guard's target. */
export function ownedByHarness(path: string): boolean {
  return /^~\/\.claude\/(?:projects|plans|todos|shell-snapshots|dev-mods|plugins)\//.test(path) || /^\/(?:private\/)?(?:tmp|var\/folders)\//.test(path);
}

/** Project-local settings: "You, in this one project only" (code.claude.com/docs/en/settings, checked 2026-11-01). */
export const LOCAL_SETTINGS = '.claude/settings.local.json';
/** A finding's scoped rule: rules load recursively, and `paths:` scopes one to matching files. */
const scopedFile = (fixId: string): string => `.claude/rules/vibesenpai/${fixId}.md`;
const AGENT_FILE = '.claude/agents/ask.md';

/** The permission entry for a command head, in the form Claude Code's own dialog writes. */
const askRule = (head: string): string => `Bash(${head} *)`;

/**
 * A PreToolUse hook that refuses Edit/Write on one path. `file_path` arrives absolute, so `~` becomes
 * `$HOME`; exit 2 blocks that call alone and its stderr is the reason. Matches the path as a JSON string.
 */
export function guardHook(path: string): object {
  const abs = path.startsWith('~/') ? `$HOME/${path.slice(2)}` : path;
  const say = `vibesenpai guard: ${path} is outside this project. Ask the developer before changing it.`;
  return {
    hooks: {
      PreToolUse: [{
        matcher: 'Edit|Write|MultiEdit|NotebookEdit',
        hooks: [{ type: 'command', timeout: 5, command: `grep -qF "\\"${abs}\\"" && { echo '${say}' >&2; exit 2; } || exit 0` }],
      }],
    },
  };
}

/** A read-only subagent: `tools:` restricts, where a command's `allowed-tools` only pre-approves (checked 2026-11-01). */
const ASK_AGENT = `---
name: ask
description: Answers the developer's questions about this project without changing anything. Use it whenever the developer asks a question rather than asking for a change.
tools: Read, Grep, Glob
---
Answer the question from the code and the docs. You cannot edit files. If the answer implies a change, describe it and stop.`;

/** Where a plan's change lands, as the pane names it. */
export function destination(p: ApplyPlan): string {
  switch (p.target) {
    case 'session':
      return 'this session only';
    case 'project-hooks':
    case 'project-permissions':
      return LOCAL_SETTINGS;
    case 'scoped-instructions':
      return scopedFile(p.fixId);
    case 'project-check':
      return 'a test or check in this project';
    case 'project-agent':
      return AGENT_FILE;
    default:
      return RULES_FILE;
  }
}

/** The printable change, for a target whose change is a fragment rather than a line. */
export function snippetFor(p: ApplyPlan): string | undefined {
  switch (p.target) {
    case 'project-permissions':
      return JSON.stringify({ permissions: { ask: [askRule(p.text)] } }, null, 2);
    case 'project-hooks':
      return JSON.stringify(guardHook(p.text), null, 2);
    case 'scoped-instructions':
      return scopedRule(p);
    case 'project-agent':
      return ASK_AGENT;
    default:
      return undefined;
  }
}

function scopedRule(p: ApplyPlan): string {
  return ['---', 'paths:', ...(p.paths ?? []).map((x) => `  - "${x}"`), '---', '', p.text].join('\n');
}

/** The request for one plan, without the marker. */
function requestFor(p: ApplyPlan): string[] {
  switch (p.target) {
    case 'project-permissions':
      return [
        `In ${LOCAL_SETTINGS}, add "${askRule(p.text)}" to permissions.ask (create the file or the list if missing, keep everything else, skip it if already there), so Claude Code asks before running \`${p.text}\`.`,
      ];
    case 'project-hooks':
      return [`Merge this PreToolUse hook into ${LOCAL_SETTINGS}, keeping every hook already there:`, snippetFor(p) as string];
    case 'scoped-instructions':
      return [`Create ${scopedFile(p.fixId)} with exactly this content (skip it if the file already exists):`, scopedRule(p)];
    case 'project-check':
      return [
        `${p.from ?? 'The project instructions'} already says "${p.text}", and it was broken anyway.`,
        'Turn it into an automated check that fails when it is broken (a test, a lint rule or a type constraint, whichever fits this project). Show me the check and where it goes before adding it.',
      ];
    case 'project-agent':
      return [`Create ${AGENT_FILE} with exactly this content (skip it if the file already exists):`, ASK_AGENT];
    default:
      return [];
  }
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
  for (const p of plans) {
    const r = requestFor(p);
    if (r.length > 0) parts.push(...(parts.length > 0 ? [''] : []), ...r);
  }
  if (session.length > 0) parts.push(...(parts.length > 0 ? [''] : []), ...session);
  parts.push(fixMarker(plans.map((p) => p.fixId)));
  return parts.join('\n');
}
