/**
 * Reading transcripts. One incremental reader, two modes.
 *
 * ── Why two modes and not two readers ────────────────────────────────────────
 *
 * `catalogued` reads up to the byte offset the catalog recorded, and nothing
 * past it. `live` reads whatever is on disk right now, including bytes written
 * since the last scan — that is what makes `agentsensei session` able to say
 * anything about the session you are sitting in.
 *
 * They are the same code with a different end offset, deliberately. Two readers
 * would drift, and the one that drifted would be `live` — the harder path, used
 * by the surface that runs most often.
 *
 * ── What this module will not do ─────────────────────────────────────────────
 *
 * It does not import the catalog. The offset arrives as a parameter instead, so
 * this stays a pure function of (path, end offset) — testable without a store,
 * and free of a cycle, since the catalog needs the byte reader that lives here.
 *
 * It never opens a source for writing. CLAUDE.md, Principle Zero: never open the
 * harness's own files for writing.
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readdirSync } from 'node:fs';

export type ReadMode =
  /** Up to the catalog's recorded offset. Deterministic across re-runs. */
  | 'catalogued'
  /** Everything on disk now, including what no scan has accounted for yet. */
  | 'live';

export type SessionRead = {
  sessionId: string;
  source: string;
  mode: ReadMode;
  /** Complete lines only — never a partial trailing record. */
  text: string;
  bytesRead: number;
  /** The offset supplied by the caller, when there was one. */
  catalogOffset: number | undefined;
  /**
   * Bytes read beyond `catalogOffset`. Non-zero only in `live` mode, and worth
   * surfacing: it is exactly the work the catalogued view cannot see yet.
   */
  ahead: number;
  /** A partial trailing line was left unread, because the harness is mid-write. */
  partialTail: boolean;
};

/** Read a byte range without loading the whole file. */
export function readRange(path: string, from: number, to: number): Buffer {
  const len = to - from;
  if (len <= 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(len);
  const fd = openSync(path, 'r');
  try {
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, from + got);
      if (n === 0) break;
      got += n;
    }
    return got === len ? buf : buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

export type ReadSessionOptions = {
  source: string;
  sessionId?: string;
  mode: ReadMode;
  /**
   * Bytes the catalog has accounted for. Required for `catalogued` — reading a
   * session the catalog has never seen would silently return nothing, and a
   * silent empty result is indistinguishable from a session with no content.
   */
  catalogOffset?: number;
};

export function readSession(opts: ReadSessionOptions): SessionRead {
  const { source, mode } = opts;
  const sessionId = opts.sessionId ?? basename(source, '.jsonl');

  if (mode === 'catalogued' && opts.catalogOffset === undefined) {
    throw new Error(
      `${sessionId} is not in the catalog — run \`agentsensei scan\` first, ` +
        `or use --live to read the source directly`,
    );
  }

  const size = statSync(source).size;
  const end = mode === 'catalogued' ? Math.min(opts.catalogOffset as number, size) : size;

  const chunk = readRange(source, 0, end);

  // Stop at the last complete line. In `live` mode the harness may be writing
  // this file right now; handing a half-written record to the parser would have
  // it counted as malformed, and unlike the catalog we get no second chance to
  // re-read it later in this process.
  const lastNl = chunk.lastIndexOf(0x0a);
  const consumed = lastNl === -1 ? 0 : lastNl + 1;

  return {
    sessionId,
    source,
    mode,
    text: chunk.subarray(0, consumed).toString('utf8'),
    bytesRead: consumed,
    catalogOffset: opts.catalogOffset,
    ahead:
      opts.catalogOffset === undefined ? 0 : Math.max(0, consumed - opts.catalogOffset),
    partialTail: consumed < chunk.length,
  };
}

/** Every `*.jsonl` under the given roots. Missing roots are not errors. */
function walk(sources: string[]): string[] {
  const out: string[] = [];
  const rec = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  for (const s of sources) rec(s);
  return out;
}

/**
 * Locate a session's transcript by id, searching the sources directly.
 *
 * Deliberately independent of the catalog: `--live` has to work on a session
 * that no scan has reached yet, which is the normal state of the session you are
 * currently in.
 */
export function findSessionSource(sources: string[], sessionId: string): string | undefined {
  const r = lookupSession(sources, sessionId);
  return r.ok ? r.source : undefined;
}

/** Minimum prefix length. Four hex characters is 65,536 — enough to be meant. */
export const MIN_ID_PREFIX = 4;

export type SessionLookup =
  | { ok: true; sessionId: string; source: string; via: 'exact' | 'prefix' }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'too-short' }
  | { ok: false; reason: 'ambiguous'; candidates: string[] };

/**
 * Resolve a session id, accepting the short form every surface prints.
 *
 * ── The id you can see must be the id you can use ──────────────────────────
 *
 * Reports print eight characters — `session e3a3f0d4 · 5803 events` — and this
 * matched on exact equality, so the only id a reader ever saw was the one
 * `--session` rejected:
 *
 * ```
 *   now --session e3a3f0d4  ->  no transcript found under: …
 * ```
 *
 * Exact first, so a full id can never be read as an ambiguous prefix. Then a
 * unique prefix.
 *
 * **An ambiguous prefix is an error, never a guess.** Picking one would analyse
 * somebody else's session under a header that looks authoritative — the same
 * failure `resolveCurrentSession` avoids by printing that it guessed.
 */
export function lookupSession(sources: string[], id: string): SessionLookup {
  const files = walk(sources);

  const exact = files.find((p) => basename(p, '.jsonl') === id);
  if (exact !== undefined) return { ok: true, sessionId: id, source: exact, via: 'exact' };

  if (id.length < MIN_ID_PREFIX) return { ok: false, reason: 'too-short' };

  const hits = files.filter((p) => basename(p, '.jsonl').startsWith(id));
  if (hits.length === 0) return { ok: false, reason: 'not-found' };
  if (hits.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      candidates: hits.map((p) => basename(p, '.jsonl')).sort(),
    };
  }
  const only = hits[0] as string;
  return { ok: true, sessionId: basename(only, '.jsonl'), source: only, via: 'prefix' };
}

/**
 * Every transcript under the configured sources.
 *
 * The one enumeration the multi-session surfaces share, so a page cannot
 * disagree with itself about which sessions exist. `report` used to drive off
 * the catalog and saw 4 of 8 — printing "no transcripts cover this period" for
 * a window a listed session spanned.
 *
 * Built on `walk`, which is plain `readdirSync`. The detached standing pass had
 * its own copy shelling out to `find`; this removes that subprocess.
 */
export function discoverTranscripts(sources: string[]): string[] {
  return walk(sources).filter((p) => !isOurOwnJudgeSession(p));
}

/**
 * The directory the judge runs its headless child in.
 *
 * Encoded into the harness's project-directory name, so a transcript written by
 * our own judge lands somewhere recognisable.
 */
export const JUDGE_CWD_MARKER = 'agentsensei-judge';

/**
 * Directory-name fragments that mean "a transcript our own model call wrote".
 *
 * `JUDGE_CWD_MARKER` is what we create *now*, but earlier probes ran in
 * `/private/tmp/as-judge-probe` and `/private/tmp/as-judge-step0`, which the
 * marker does not match. Measured on a real machine: of 1,009 transcripts in
 * `~/.claude/projects`, **995 were our own** — 494MB of headless children from
 * one day of measurement runs — and 5 of those leaked past the filter because
 * they predate the marker. They were being analysed as the user's work.
 *
 * Matching a list rather than one string, because the cost of a false negative
 * is analysing our own output and reporting it as theirs, while the cost of a
 * false positive is skipping a session whose path contains `as-judge`, which no
 * real project is called.
 */
const OUR_CWD_FRAGMENTS = [JUDGE_CWD_MARKER, 'as-judge-'];

/**
 * Is this transcript one our own judge produced?
 *
 * **Measured, not theorised.** A headless `claude -p` child writes its own
 * transcript into `~/.claude/projects`, and without this the judge analyses —
 * and judges — its own output. Three probe calls took this machine from 9
 * discovered sessions to 12 before anyone noticed, and a judge run took it 14
 * to 15.
 *
 * `--bare` would have prevented the child entirely, but it demands
 * `ANTHROPIC_API_KEY`: on a subscription it returns `is_error: true` and
 * *"Not logged in"* without calling anything. So the child is a real session
 * and the only reliable fix is to recognise where it ran.
 */
export function isOurOwnJudgeSession(path: string): boolean {
  return OUR_CWD_FRAGMENTS.some((f) => path.includes(f));
}

export type LatestSession = { source: string; sessionId: string; mtimeMs: number };

/**
 * The most recently written transcript.
 *
 * This is how `now` finds "the session you are running from" when the harness
 * has not told us which one that is. It is a heuristic and is reported as one —
 * the session id is printed, so a wrong guess is visible rather than silently
 * analysing someone else's work.
 */
export function findLatestSession(sources: string[]): LatestSession | undefined {
  let best: LatestSession | undefined;
  for (const source of walk(sources)) {
    let mtimeMs: number;
    try {
      const st = statSync(source);
      if (st.size === 0) continue;
      mtimeMs = st.mtimeMs;
    } catch {
      continue;
    }
    if (best === undefined || mtimeMs > best.mtimeMs) {
      best = { source, sessionId: basename(source, '.jsonl'), mtimeMs };
    }
  }
  return best;
}

/**
 * Which session `now` should look at.
 *
 * Precedence mirrors the config rule — explicit beats ambient, ambient beats
 * guessing — and the chosen `via` is returned so the caller can print it.
 * Guessing silently would be the failure mode: analysing a different session
 * than the one you are in, with output that looks authoritative.
 */
export function resolveCurrentSession(
  sources: string[],
  opts: { sessionId?: string; env?: NodeJS.ProcessEnv } = {},
): { sessionId: string; source: string; via: 'flag' | 'env' | 'latest' } | undefined {
  const env = opts.env ?? process.env;

  if (opts.sessionId !== undefined) {
    const source = findSessionSource(sources, opts.sessionId);
    return source === undefined
      ? undefined
      : { sessionId: opts.sessionId, source, via: 'flag' };
  }

  // Whatever the harness exposes. Checked rather than assumed: if neither
  // variable is set we fall through instead of inventing an id.
  const fromEnv = env['AGENTSENSEI_SESSION_ID'] ?? env['CLAUDE_SESSION_ID'];
  if (fromEnv !== undefined && fromEnv !== '') {
    const source = findSessionSource(sources, fromEnv);
    if (source !== undefined) return { sessionId: fromEnv, source, via: 'env' };
  }

  const latest = findLatestSession(sources);
  return latest === undefined
    ? undefined
    : { sessionId: latest.sessionId, source: latest.source, via: 'latest' };
}
