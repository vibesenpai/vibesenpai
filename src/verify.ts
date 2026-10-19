/**
 * Discovering what "verification" means in *this* project.
 *
 * ── Why there is no list of frameworks ───────────────────────────────────────
 *
 * `no_verification` and `inaccurate_self_report` both need to know which
 * commands check whether the code works. The obvious implementation — a list of
 * known test commands, plus a config field for the rest — was built first and is
 * wrong on its face: there are thousands of toolchains, so the detector's
 * accuracy would track how well the author guessed the user's stack. Measured on
 * a public corpus, a hand-written list missed `mise run`, `bun run` and `go
 * build`, which is most of what those repos actually ran.
 *
 * ── Verification is a behaviour, not a name ──────────────────────────────────
 *
 * Three layers, strongest last:
 *
 * 1. **Verdict shape on executed output.** Result vocabulary is far more
 *    universal than command names — pytest, jest, go test, cargo, rspec,
 *    pyright and tsc all converge on pass/fail/ok/error with counts, because
 *    they are all reporting to a human. Requires that something actually *ran*:
 *    reading a test file looks identical to running one otherwise, which is
 *    exactly the false positive measured first (`Read`, `grep expect(`,
 *    `cat >> test.ts` all matched).
 *
 * 2. **Behavioural confirmation.** A verification command is one whose **verdict
 *    changes when the code changes**. Seeing the same command both pass and
 *    fail proves it, with no vocabulary at all. This is the framework-agnostic
 *    core, and it is what excludes `git log --oneline`, which matched on shape
 *    alone but never varies.
 *
 * 3. **A learned, persisted registry.** What session 1 discovers, session 2
 *    knows. Confidence grows with history instead of being asserted up front.
 *
 * User config becomes an **override**, not the mechanism.
 *
 * ── The honest cost ─────────────────────────────────────────────────────────
 *
 * A cold start. In a brand-new project nothing is confirmed, so the detectors
 * stay quiet for a session or two. That is the same rule that makes `tool_loop`
 * skip calls it cannot distinguish: `unknown` beats guessing, and silence beats
 * flagging every edit in a repo whose test command we have not seen yet.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA, checkVersion, stamp, type Versioned } from './schema.ts';
import { executablePart } from './detect/command.ts';
import type { Event } from './types.ts';

/**
 * Output that reports a verdict about code.
 *
 * Chosen to span frameworks rather than name them. Every pattern here is
 * something a tool prints *to a human* about whether things worked.
 */
const VERDICT_SHAPE: RegExp[] = [
  /\b\d+\s+(?:passed|failed|passing|failing|errors?|failures?|warnings?)\b/i,
  /\b(?:passed|failed|errors?)\s*[:=]\s*\d+/i,
  /^(?:FAIL|PASS|ok|not ok)\b/im, // TAP, jest, go test
  /\b(?:AssertionError|assert(?:ion)? failed|panic:)/i,
  /\bTests?:\s/i,
  /\b(?:test|spec)s? (?:passed|failed)\b/i,
  /\b(?:build (?:succeeded|failed)|compilation (?:successful|failed))\b/i,
  /^\s*(?:✓|✗|√|×)\s/m,
  /\b\d+\s+errors?,\s*\d+\s+warnings?/i,
];

/**
 * Commands that write a file and echo its contents.
 *
 * `cat >> test/foo.test.ts <<EOF … EOF` prints assertion text, which matches the
 * verdict vocabulary while verifying nothing at all.
 */
const WRITE_SHAPE = /(^|\s)(?:cat|tee|printf|echo)\b[^|]*>>?\s|<<-?\s*['"]?[A-Za-z_]+/;

/**
 * A whole line that only prepares the environment and runs nothing.
 *
 * Distinct from PREFIX_NOISE, which strips a prefix *within* a line. This skips
 * the line entirely, for scripts written across several lines.
 */
const SETUP_ONLY =
  /^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)|export\s+\S+|source\s+(?:"[^"]*"|'[^']*'|\S+)|\.\s+\S+|set\s+[-+]\S+|unset\s+\S+|[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*))\s*(?:#.*)?$/;

/** Leading noise that hides the actual verb. */
const PREFIX_NOISE = [
  /^\s*\(\s*/, // subshell
  /^\s*[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/, // FOO=bar
  /^\s*cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/, // cd X &&
  /^\s*source\s+\S+\s*&&\s*/,
  /^\s*\.\s+\S+\s*&&\s*/,
  /^\s*(?:time|env|nice|exec|sudo)\s+/,
];

/**
 * A stable key for "the same command".
 *
 * Two jobs. It strips the prefixes that hide the verb — measured: a three-word
 * key turned `cd ~/project && npx vitest run` into `cd ~/project`, which was the
 * single most common "command" in the probe. And it reduces an executable path
 * to its basename, so `./node_modules/.bin/vitest` and
 * `tooling/.venv/bin/pytest` key as the tools they are rather than as the paths
 * they were invoked by.
 */
export function commandKey(command: string | undefined): string | undefined {
  if (command === undefined) return undefined;
  // Skip lines that only set up the environment. A multi-line script often puts
  // `cd` on its own line and the real command on the next, and taking the first
  // non-empty line made `cd ~/Workspace/agentsensei` the most frequently
  // "confirmed" verification command in the corpus.
  const firstLine = executablePart(command)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !SETUP_ONLY.test(l));
  if (firstLine === undefined) return undefined;

  // Peel prefixes repeatedly: `cd x && FOO=1 time pytest` has three.
  let text: string = firstLine;
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of PREFIX_NOISE) {
      const next: string = text.replace(re, '');
      if (next !== text) {
        text = next;
        changed = true;
      }
    }
  }

  // Drop redirections first, THEN split on operators: doing it the other way
  // leaves the `2` of `2>&1` behind as an argument, so `npm test 2>&1` keyed as
  // `npm test 2` and never matched `npm test`.
  text = text.replace(/\s*\d?>&\d/g, '');
  text = text.split(/\s*(?:\|\||&&|;|\||>>|>|<)\s*/)[0] ?? '';
  text = text.trim();
  if (text === '') return undefined;

  const tokens = text.split(/\s+/);
  const head = tokens[0] as string;
  // `./node_modules/.bin/vitest` -> `vitest`
  const verb = head.includes('/') ? (head.split('/').pop() as string) : head;
  // Keep up to two non-flag arguments: `mise run test:ci`, `uv run pyright`.
  const args = tokens.slice(1).filter((t) => !t.startsWith('-')).slice(0, 2);
  return [verb, ...args].join(' ').slice(0, 60);
}

/** Did this call actually execute something, as opposed to read or fetch? */
export function didExecute(call: Event | undefined): boolean {
  if (call === undefined || call.turnType !== 'tool_use') return false;
  if (call.command === undefined) return false;
  if (WRITE_SHAPE.test(call.command)) return false;
  return executablePart(call.command).trim() !== '';
}

/** Does this output report a verdict about the code? */
export function hasVerdictShape(text: string | undefined): boolean {
  if (text === undefined || text.trim() === '') return false;
  return VERDICT_SHAPE.some((re) => re.test(text));
}

export function resultFailed(e: Event): boolean {
  if (e.isError === true) return true;
  if (e.exitCode !== undefined && e.exitCode !== 0) return true;
  // Some harness variants record neither, so the verdict text is the fallback.
  return /\b(?:FAIL|failed|failing|error|errors|panic:|not ok)\b/i.test(e.textSummary ?? '');
}

export type VerificationEntry = {
  command: string;
  pass: number;
  fail: number;
  firstSeen: string;
  lastSeen: string;
  /**
   * `certain` once the verdict has been seen to vary, which is what proves the
   * command responds to code changes. `high` on output shape alone.
   */
  confidence: 'certain' | 'high';
};

export type VerificationRegistry = Versioned<'verification'> & {
  /**
   * Keyed by project and command joined with NUL, so one file serves every
   * project and a project path containing a space cannot corrupt the key.
   * Machine-written only.
   */
  entries: Record<string, VerificationEntry>;
  /**
   * Explicit user decisions, always winning over anything learned.
   *
   * Nested by project rather than using the NUL-joined internal key: this is the
   * part a person edits, and a config file is no place for a control character.
   * The first version shared the internal key and silently never matched.
   */
  overrides: Record<string, Record<string, 'include' | 'exclude'>>;
};

const FILE = 'verification.json';
// NUL, because a project path or a command may contain a space and a space
// separator could collide. Written as an escape: an invisible control
// character in source is exactly how a silent mismatch happens, and one did —
// a doc comment below held a literal NUL, so an edit targeting it no-op'd.
const SEP = '\u0000';

const keyOf = (project: string, command: string): string => `${project}${SEP}${command}`;

export function emptyRegistry(): VerificationRegistry {
  return { ...stamp('verification'), entries: {}, overrides: {} };
}

export function readRegistry(dir: string): VerificationRegistry {
  try {
    const r = JSON.parse(readFileSync(join(dir, FILE), 'utf8')) as VerificationRegistry;
    if (checkVersion('verification', r.v).ok && r.entries) {
      return { ...r, overrides: r.overrides ?? {} };
    }
  } catch {
    // A missing or unreadable registry costs a cold start, not a crash.
  }
  return emptyRegistry();
}

export function writeRegistry(dir: string, r: VerificationRegistry): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, FILE);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(r, null, 2), { mode: 0o600 });
  renameSync(tmp, target);
}

export function registryExists(dir: string): boolean {
  return existsSync(join(dir, FILE));
}

/**
 * Walk a session and record what verified.
 *
 * Pairs each result with the call that produced it, which is why this is a
 * session pass rather than a per-result test: a result alone cannot say what ran.
 */
export function learn(
  registry: VerificationRegistry,
  events: Event[],
  project: string,
  now: string,
): VerificationRegistry {
  const entries = { ...registry.entries };
  let lastCall: Event | undefined;

  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.turnType === 'tool_use') {
      lastCall = e;
      continue;
    }
    if (e.turnType !== 'tool_result') continue;
    if (!didExecute(lastCall)) continue;
    if (!hasVerdictShape(e.textSummary)) continue;

    const command = commandKey(lastCall?.command);
    if (command === undefined) continue;

    const k = keyOf(project, command);
    const prior = entries[k];
    const failed = resultFailed(e);
    const pass = (prior?.pass ?? 0) + (failed ? 0 : 1);
    const fail = (prior?.fail ?? 0) + (failed ? 1 : 0);

    entries[k] = {
      command,
      pass,
      fail,
      firstSeen: prior?.firstSeen ?? now,
      lastSeen: now,
      // Verdict variation is the proof. Until then the claim rests on output
      // shape, which `git log --oneline` matched once in the corpus.
      confidence: pass > 0 && fail > 0 ? 'certain' : 'high',
    };
  }

  return { ...registry, entries };
}

export type VerificationLookup = {
  /** Is this command known to verify in this project? */
  isVerification(command: string | undefined): boolean;
  /** True when nothing is known yet — detectors must stay silent. */
  readonly cold: boolean;
  /** How many commands are known, for `doctor`. */
  readonly known: number;
};

export type LookupOptions = {
  /**
   * Require verdict variation before trusting a command.
   *
   * On by default for anything that produces a *finding*: shape alone admitted
   * `git log --oneline` once across 253 sessions, and a `certain` detector
   * cannot rest on that.
   */
  requireConfirmed?: boolean;
};

export function lookupFor(
  registry: VerificationRegistry,
  project: string,
  opts: LookupOptions = {},
): VerificationLookup {
  const requireConfirmed = opts.requireConfirmed ?? true;
  const overrides: Record<string, 'include' | 'exclude'> =
    registry.overrides[project] ?? {};

  const usable = Object.entries(registry.entries).filter(([k, v]) => {
    if (!k.startsWith(`${project}${SEP}`)) return false;
    const o = overrides[v.command];
    if (o === 'exclude') return false;
    if (o === 'include') return true;
    return requireConfirmed ? v.confidence === 'certain' : true;
  });
  const commands = new Set(usable.map(([, v]) => v.command));

  // An include may name a command never observed, so it still has to work.
  for (const [command, mode] of Object.entries(overrides)) {
    if (mode !== 'include') continue;
    const key = commandKey(command);
    if (key !== undefined) commands.add(key);
  }

  return {
    isVerification(command) {
      const key = commandKey(command);
      return key !== undefined && commands.has(key);
    },
    cold: commands.size === 0,
    known: commands.size,
  };
}

/**
 * A lookup over an explicit command list.
 *
 * For tests, and for the `--verify-command` override where a user insists. It is
 * deliberately **not** how the product decides: a list cannot keep up with the
 * toolchains that exist, which is the whole reason for the registry above.
 */
export function staticLookup(commands: string[]): VerificationLookup {
  const keys = new Set(commands.map((c) => commandKey(c)).filter((k): k is string => k !== undefined));
  return {
    isVerification(command) {
      const key = commandKey(command);
      return key !== undefined && keys.has(key);
    },
    cold: keys.size === 0,
    known: keys.size,
  };
}

/** A project where nothing is known yet. Detectors must stay silent. */
export function coldLookup(): VerificationLookup {
  return { isVerification: () => false, cold: true, known: 0 };
}

export const VERIFICATION_SCHEMA_VERSION = SCHEMA.verification;
