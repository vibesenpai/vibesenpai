/**
 * Reading transcripts. One incremental reader, two modes.
 *
 * ── Why two modes and not two readers ────────────────────────────────────────
 *
 * `catalogued` reads up to the byte offset the catalog recorded, and nothing
 * past it. `live` reads whatever is on disk right now, including bytes written
 * since the last scan — that is what makes `agentsensei now` able to say
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
  return walk(sources).find((p) => basename(p, '.jsonl') === sessionId);
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
