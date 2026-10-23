/**
 * Installing into the harness's own settings — the most dangerous thing this
 * tool does, so it is pure functions here and I/O at the edge.
 *
 * ── The rule that outranks the feature ─────────────────────────────────────
 *
 * **Merge, never replace.** Measured on a real machine before writing any of
 * this: `~/.claude/settings.json` already had **ten populated hook events**, one
 * hook each, `Stop` among them. Replacing a `Stop` array would silently break
 * whatever was already there, which is exactly the "Self-Initiated Overreach"
 * failure this project exists to detect. Doing it to someone's config while
 * claiming to analyse their habits would be indefensible.
 *
 * So every function here takes the existing settings and returns new settings
 * with our entries **added**, and `remove` takes them away again by matching
 * only what we added. Nothing else in the file is read, rewritten, or reordered
 * beyond what `JSON.stringify` does to the keys we touch.
 *
 * ── Identification ─────────────────────────────────────────────────────────
 *
 * Our entries carry a marker so `remove` can find them without guessing, and so
 * a second install is idempotent rather than additive. Matching on the command
 * string alone would break the moment someone moved the checkout.
 */

export const MARKER = 'agentsensei';

/**
 * The `/agentsensei` slash command.
 *
 * A custom command is a markdown file under `.claude/commands/`, and `` !`cmd` ``
 * in its body runs a shell command and injects the output — gated by
 * `allowed-tools` in the frontmatter. Verified in Anthropic's own
 * `commit-commands/commands/commit-push-pr.md`.
 *
 * This is what makes `/agentsensei` real **without packaging a plugin**: a file
 * in their commands directory, installed and removed with everything else.
 *
 * The body asks for the output verbatim. Letting the model summarise would
 * replace evidence with a paraphrase of evidence, which is the one thing this
 * project will not do.
 */
export function commandFileBody(repoRoot: string, nodePath = process.execPath, compiled = false): string {
  return `---
description: What agentsensei found in this session
allowed-tools: Bash(${nodePath}:*)
---

!\`${cliCommand(repoRoot, nodePath, compiled)} now\`

Reproduce the output above in a code block, preserving every line, number and
column exactly. Add no summary and no commentary: it is evidence, and
paraphrasing it defeats the point.

You may bold the figures — token counts, turn numbers, percentages — and
nothing else. The command cannot colour its own output on this path, because
it is piped to you rather than written to a terminal, so this is the only
emphasis the reader gets.
`;
}

/**
 * The `/agentsensei-fix` command — one evidence-backed change to try.
 *
 * The body asks the model to **ask before adopting**. A slash command's output
 * enters the context either way, so consent cannot be mechanical: it is an
 * instruction not to act until the user says yes. That is the difference
 * between handing someone a suggestion and applying one to their session.
 */
export function fixCommandBody(repoRoot: string, nodePath = process.execPath, compiled = false): string {
  return `---
description: One evidence-backed change to try, from your own sessions
allowed-tools: Bash(${nodePath}:*)
---

!\`${cliCommand(repoRoot, nodePath, compiled)} fix\`

Reproduce the recommendation above in a code block, preserving every line and
figure exactly. You may bold the figures and nothing else — the command cannot
colour its own output when piped to you.

Then ASK whether to adopt it for the rest of this session. Do not adopt it,
act on it, or change how you work until the answer is yes.
`;
}

/**
 * Where the command files live.
 *
 * **A subdirectory, because that is what namespaces them.** A command at
 * `.claude/commands/agentsensei/fix.md` is `/agentsensei:fix`; the same file
 * flat at `.claude/commands/agentsensei-fix.md` is `/agentsensei-fix`. From the
 * harness changelog: *"Restored namespacing in command names based on
 * subdirectories … `.claude/commands/frontend/component.md` is now
 * `/frontend:component`"*.
 *
 * That also gets the colon form without packaging a plugin — `mem0:remember`
 * and `commit-commands:commit` are plugin commands, but a nested user command
 * reaches the same shape.
 */
/**
 * The `/agentsensei:report` command.
 *
 * **It does not ask for the output to be reproduced**, which is the one way its
 * body differs from the other two. There is nothing to reproduce: the evidence
 * is in the file. Restating the findings in chat would be exactly the
 * paraphrase-instead-of-evidence that `now.md` and `fix.md` are worded to
 * prevent, and it would do it while the reader had the real thing open.
 *
 * **`--open` here, opt-in at the CLI.** Someone typing this command is asking
 * to look at a report, so making them copy a path afterwards is a step with no
 * purpose. `report --html` on its own still does not open anything: it can be
 * run from a script or a pipe, and spawning a browser there would be the kind
 * of surprise this project is built to avoid.
 */
export function generateReportCommandBody(repoRoot: string, nodePath = process.execPath, compiled = false): string {
  return `---
description: Write a self-contained HTML report of your sessions
allowed-tools: Bash(${nodePath}:*)
---

!\`${cliCommand(repoRoot, nodePath, compiled)} report --html --open\`

The report has already opened in their browser. Give them the file path from
the output above, on its own line, and say it is open. Nothing else.

Do NOT summarise the findings, list the sessions, or describe what is in the
report. It is a file; they are looking at it. Repeating its contents here would
replace the evidence with a paraphrase of the evidence.
`;
}

export function commandDir(home: string): string {
  return `${home}/.claude/commands/${MARKER}`;
}

export function commandFilePath(home: string): string {
  return `${commandDir(home)}/now.md`;
}

export function fixCommandFilePath(home: string): string {
  return `${commandDir(home)}/fix.md`;
}

export function generateReportCommandFilePath(home: string): string {
  return `${commandDir(home)}/generate-report.md`;
}

/**
 * Every command file we install, so install and uninstall cannot disagree.
 *
 * **One list, because the failure is silent.** `uninstall` removes the files it
 * knows about and then calls `rmdirSync`, which refuses a non-empty directory —
 * deliberately, so somebody else's command in there survives. A file we created
 * and forgot to list would leave the directory non-empty, make `rmdirSync`
 * throw into an empty catch, and quietly cost the byte-identical uninstall the
 * CLI verifies with a diff.
 */
export function ourCommandFiles(home: string): string[] {
  return [commandFilePath(home), fixCommandFilePath(home), generateReportCommandFilePath(home)];
}

/**
 * The flat files an earlier version installed.
 *
 * Removed on install, like the stale statusline: leaving them behind means two
 * `/agentsensei` entries, one of them pointing at the old un-namespaced form.
 */
export function legacyCommandFiles(home: string): string[] {
  return [`${home}/.claude/commands/${MARKER}.md`, `${home}/.claude/commands/${MARKER}-fix.md`];
}

/** A Claude Code hook entry, as the settings file holds them. */
export type HookCommand = {
  type: 'command';
  command: string;
  timeout?: number;
  /** Ours. Absent on everybody else's entries, which is how `remove` is safe. */
  __agentsensei?: true;
};

export type HookMatcher = { matcher?: string; hooks: HookCommand[] };

export type Settings = {
  statusLine?: { type: string; command: string; padding?: number } | null;
  hooks?: Record<string, HookMatcher[]>;
  [key: string]: unknown;
};

export type InstallPlan = {
  /** Shell command for the `Stop` hook. */
  hookCommand: string;
  /**
   * Shell command for the `SessionStart` hook.
   *
   * Spawns the standing pass and prints nothing, so history is processed the
   * moment a session opens and surfaces at the first `Stop` boundary.
   */
  sessionStartCommand: string;
};

/**
 * How to invoke our own CLI from a file the harness will run.
 *
 * Same constraint as the hooks: a `.ts` path with `--experimental-strip-types`
 * cannot work from inside `node_modules`, so the compiled entry point wins
 * whenever it exists.
 */
export function cliCommand(repoRoot: string, nodePath = process.execPath, compiled = false): string {
  return compiled
    ? `${nodePath} ${repoRoot}/dist/src/cli.js`
    : `${nodePath} --experimental-strip-types ${repoRoot}/src/cli.ts`;
}

/**
 * The commands to install, derived from where the checkout actually is.
 *
 * Absolute paths because a hook runs with an unpredictable working directory.
 * `|| true` on the hook because Principle Zero requires every hook to exit 0
 * unconditionally, whatever happens inside it — belt as well as the braces the
 * script already wears.
 */
export function planFor(repoRoot: string, nodePath = process.execPath, compiled = false): InstallPlan {
  // Prefer the compiled hook, and not as an optimisation — **Node refuses to
  // strip types for anything under `node_modules`**:
  //
  //     Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types
  //     is currently unsupported for files under node_modules
  //
  // A globally installed package lives under `node_modules`, so wiring
  // `--experimental-strip-types scripts/hook-stop.ts` from there produces a
  // hook that can only fail — and `|| true` means it fails *silently*, which
  // is the worst of the two. Verified by installing the tarball and running
  // the exact command this function writes.
  //
  // The `.ts` path is kept for a dev checkout with no `dist/`, where it is the
  // only thing that works.
  const run = (script: string): string =>
    compiled
      ? `${nodePath} ${repoRoot}/dist/scripts/${script}.js`
      : `${nodePath} --experimental-strip-types ${repoRoot}/scripts/${script}.ts`;
  return {
    hookCommand: `${run('hook-stop')} || true`,
    sessionStartCommand: `${run('hook-session-start')} || true`,
  };
}

/** Is this one of ours? */
function isOurs(h: HookCommand): boolean {
  return h.__agentsensei === true || h.command.includes(`${MARKER}/scripts/`);
}

/**
 * Drop a statusline of ours, leaving anyone else's untouched.
 *
 * **Load-bearing on upgrade, not just on uninstall.** The previous version set
 * a statusline pointing at `scripts/statusline.ts`; that script no longer
 * exists, so installing over it without this would leave a command the harness
 * runs on every render and which can only fail. Verified against a real machine
 * that had exactly that state.
 */
export function dropOurStatusLine(settings: Settings): Settings {
  const sl = settings.statusLine;
  if (sl === undefined || sl === null) return settings;
  if (!sl.command.includes(`${MARKER}/scripts/`)) return settings;
  const out = { ...settings };
  // Deleted, never set to null: the key is absent on a machine that never had
  // one, and inventing it would make uninstall inexact.
  delete out.statusLine;
  return out;
}

/**
 * Add our `Stop` hook, leaving every existing entry in place.
 *
 * Idempotent: installing twice replaces our entry rather than adding a second.
 * The timeout is explicit and well under the harness budget, because Principle
 * Zero requires a hung analyzer to be killed rather than waited on.
 */
export function addHook(settings: Settings, plan: InstallPlan, timeout = 5): Settings {
  const hooks = { ...(settings.hooks ?? {}) };

  /** Add one of ours to one event, leaving every existing entry in place. */
  const into = (event: string, command: string): void => {
    const ours: HookCommand = { type: 'command', command, timeout, __agentsensei: true };
    // Our own matcher group, so we never touch anyone else's. A matcher-less
    // group applies to every occurrence of the event, which is what we want.
    const withoutOurs = (hooks[event] ?? [])
      .map((m) => ({ ...m, hooks: m.hooks.filter((h) => !isOurs(h)) }))
      .filter((m) => m.hooks.length > 0);
    hooks[event] = [...withoutOurs, { hooks: [ours] }];
  };

  into('Stop', plan.hookCommand);
  // SessionStart only triggers the standing pass; it prints nothing, so nothing
  // of ours ever enters the model's context.
  into('SessionStart', plan.sessionStartCommand);

  return { ...settings, hooks };
}

/**
 * Take ours out and leave everything else exactly as it was.
 *
 * **Still removes a statusline**, although nothing sets one any more: anyone who
 * installed the previous version has ours in that slot, and an uninstall that
 * left it behind would leave a dead command pointing at a deleted script.
 *
 * Matched on the marker, never on position. An empty `Stop` array is removed
 * rather than left behind as `[]`, so uninstall is byte-identical to never
 * having installed — which is the property the CLI verifies with a diff.
 */
export function remove(settings: Settings): Settings {
  const out: Settings = { ...settings };

  if (settings.hooks !== undefined) {
    const hooks: Record<string, HookMatcher[]> = {};
    for (const [event, matchers] of Object.entries(settings.hooks)) {
      const kept = matchers
        .map((m) => ({ ...m, hooks: m.hooks.filter((h) => !isOurs(h)) }))
        .filter((m) => m.hooks.length > 0);
      if (kept.length > 0) hooks[event] = kept;
    }
    out.hooks = hooks;
  }

  return dropOurStatusLine(out);
}

/**
 * A human-readable diff of what would change — shown before anything is written.
 *
 * Deliberately not a real JSON diff. What someone needs to decide is "which of
 * my keys does this touch, and does it remove anything of mine", and a
 * line-level diff of a reformatted settings file buries that.
 */
export function describeChange(before: Settings, after: Settings): string[] {
  const out: string[] = [];

  for (const event of ['Stop', 'SessionStart']) {
    const b = before.hooks?.[event] ?? [];
    const a = after.hooks?.[event] ?? [];
    const bn = b.reduce((n, m) => n + m.hooks.length, 0);
    const an = a.reduce((n, m) => n + m.hooks.length, 0);
    if (bn === an) continue;
    out.push(`  hooks.${event.padEnd(13)}${bn} hook(s) → ${an} hook(s)`);
    for (const m of a) {
      for (const h of m.hooks) {
        const tag = h.__agentsensei === true ? '+ ' : '  ';
        out.push(`    ${tag}${h.command.slice(0, 88)}`);
      }
    }
  }

  const b = before.statusLine ?? null;
  const a = after.statusLine ?? null;
  if (JSON.stringify(b) !== JSON.stringify(a)) {
    out.push(`  statusLine        ${b === null ? '(none)' : b.command.slice(0, 60)} → ${a === null ? '(none)' : a.command.slice(0, 60)}`);
  }

  // Every other top-level key is listed as untouched, because "what does this
  // leave alone" is the question someone actually has.
  const untouched = Object.keys(before).filter((k) => k !== 'hooks' && k !== 'statusLine');
  if (untouched.length > 0) out.push(`  untouched         ${untouched.join(', ')}`);

  const otherEvents = Object.keys(before.hooks ?? {}).filter(
    (e) => e !== 'Stop' && e !== 'SessionStart',
  );
  if (otherEvents.length > 0) {
    out.push(`  hooks untouched   ${otherEvents.join(', ')}`);
  }

  return out;
}
