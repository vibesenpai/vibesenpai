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
  /** Shell command for the statusline. */
  statusLineCommand: string;
};

/**
 * The commands to install, derived from where the checkout actually is.
 *
 * Absolute paths because a hook runs with an unpredictable working directory.
 * `|| true` on the hook because Principle Zero requires every hook to exit 0
 * unconditionally, whatever happens inside it — belt as well as the braces the
 * script already wears.
 */
export function planFor(repoRoot: string, nodePath = process.execPath): InstallPlan {
  const run = (script: string): string =>
    `${nodePath} --experimental-strip-types ${repoRoot}/scripts/${script}`;
  return {
    hookCommand: `${run('hook-stop.ts')} || true`,
    statusLineCommand: run('statusline.ts'),
  };
}

/** Is this one of ours? */
function isOurs(h: HookCommand): boolean {
  return h.__agentsensei === true || h.command.includes(`${MARKER}/scripts/`);
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
  const existing = hooks['Stop'] ?? [];

  const ours: HookCommand = {
    type: 'command',
    command: plan.hookCommand,
    timeout,
    __agentsensei: true,
  };

  // Our own matcher group, so we never touch anyone else's. A matcher-less
  // group applies to every Stop, which is what we want.
  const withoutOurs = existing
    .map((m) => ({ ...m, hooks: m.hooks.filter((h) => !isOurs(h)) }))
    .filter((m) => m.hooks.length > 0);

  return { ...settings, hooks: { ...hooks, Stop: [...withoutOurs, { hooks: [ours] }] } };
}

/**
 * Set the statusline, but **never over somebody else's**.
 *
 * Returns the settings unchanged when a different statusline is configured. A
 * statusline is a single slot, so installing ours would silently remove whatever
 * was there — and a terminal prompt someone built is not ours to take. The CLI
 * reports the refusal; it does not work around it.
 */
export function addStatusLine(settings: Settings): Settings | 'occupied' {
  const current = settings.statusLine;
  if (current !== undefined && current !== null && !current.command.includes(`${MARKER}/scripts/`)) {
    return 'occupied';
  }
  return settings;
}

/** Set our statusline, having established the slot is free or ours. */
export function setStatusLine(settings: Settings, plan: InstallPlan): Settings {
  return {
    ...settings,
    statusLine: { type: 'command', command: plan.statusLineCommand, padding: 0 },
  };
}

/**
 * Take ours out and leave everything else exactly as it was.
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

  const sl = settings.statusLine;
  if (sl !== undefined && sl !== null && sl.command.includes(`${MARKER}/scripts/`)) {
    // **Deleted, not set to null.** Measured on a real machine: the key is
    // *absent* when no statusline is configured, and an earlier version set
    // `null` here — adding a key that was never there, so uninstall was not
    // byte-exact. The test missed it because the fixture encoded the same wrong
    // assumption (`statusLine: null`) on both sides.
    //
    // Absent and null mean the same thing to the harness, so deleting is exact
    // in effect for both starting shapes, and it is the only one of the two that
    // cannot invent a key.
    delete out.statusLine;
  }

  return out;
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

  const beforeStop = before.hooks?.['Stop'] ?? [];
  const afterStop = after.hooks?.['Stop'] ?? [];
  const beforeCount = beforeStop.reduce((n, m) => n + m.hooks.length, 0);
  const afterCount = afterStop.reduce((n, m) => n + m.hooks.length, 0);

  if (beforeCount !== afterCount) {
    out.push(`  hooks.Stop        ${beforeCount} hook(s) → ${afterCount} hook(s)`);
    for (const m of afterStop) {
      for (const h of m.hooks) {
        const tag = h.__agentsensei === true ? '+ ' : '  ';
        out.push(`    ${tag}${h.command.slice(0, 92)}`);
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

  const otherEvents = Object.keys(before.hooks ?? {}).filter((e) => e !== 'Stop');
  if (otherEvents.length > 0) {
    out.push(`  hooks untouched   ${otherEvents.join(', ')}`);
  }

  return out;
}
