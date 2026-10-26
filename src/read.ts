/**
 * Reading transcripts: one reader, two modes (`catalogued` stops at the catalog's offset, `live`
 * reads what is on disk). Takes the offset as a parameter rather than importing the catalog.
 * Never opens a harness file for writing.
 */

import { closeSync, openSync, readSync, statSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

type ReadMode =
  /** Up to the catalog's recorded offset. Deterministic across re-runs. */
  | 'catalogued'
  /** Everything on disk now, including what no scan has accounted for yet. */
  | 'live';

type SessionRead = {
  sessionId: string;
  source: string;
  mode: ReadMode;
  /** Complete lines only — never a partial trailing record. */
  text: string;
  bytesRead: number;
  /** The offset supplied by the caller, when there was one. */
  catalogOffset: number | undefined;
  /** Bytes read beyond `catalogOffset`; non-zero only in `live` mode. */
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

type ReadSessionOptions = {
  source: string;
  sessionId?: string;
  mode: ReadMode;
  /** Bytes the catalog has accounted for. Required for `catalogued`, so it never silently returns nothing. */
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

  // Stop at the last complete line: in `live` mode the harness may be mid-write.
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

/** Locate a session's transcript by id, without the catalog (`--live` must work before any scan). */
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
 * Resolve a session id, accepting the 8-char short form surfaces print. Exact match first, then a
 * unique prefix. An ambiguous prefix is an error, never a guess.
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

/** The harness's project directory name, e.g. `-Users-me-Workspace-app`. Findings are keyed on it. */
export function projectOf(source: string): string {
  const parts = source.split(/[\\/]/).filter((p) => p !== '');
  return parts.at(-2) ?? 'unknown';
}

/** The readable tail of a project key, e.g. `app`. Display only, never a key. */
export function projectLabel(project: string): string {
  return project.split('-').filter(Boolean).pop() ?? project;
}

/** Every transcript under the sources, minus our own judge's; the one enumeration all surfaces share. */
export function discoverTranscripts(sources: string[]): string[] {
  return walk(sources).filter((p) => !isOurOwnJudgeSession(p));
}

/** The judge child's working directory name, so its transcripts are recognisable. */
export const JUDGE_CWD_MARKER = 'agentsensei-judge';

/** Path fragments of our own judge transcripts; `as-judge-` covers probes that predate the marker. */
const OUR_CWD_FRAGMENTS = [JUDGE_CWD_MARKER, 'as-judge-'];

/**
 * Is this transcript one our own judge produced? The `claude -p` child writes a real session
 * (`--bare` needs an API key), so without this the judge would judge itself.
 */
function isOurOwnJudgeSession(path: string): boolean {
  return OUR_CWD_FRAGMENTS.some((f) => path.includes(f));
}

type LatestSession = { source: string; sessionId: string; mtimeMs: number };

/** The most recently written transcript: `now`'s fallback guess, reported as a guess. */
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

/** Which session `now` should look at: flag, then env, then latest. `via` says which, so a guess is visible. */
export function resolveCurrentSession(
  sources: string[],
  opts: { sessionId?: string; env?: NodeJS.ProcessEnv } = {},
): { sessionId: string; source: string; via: 'flag' | 'env' | 'latest' } | undefined {
  const env = opts.env ?? process.env;

  if (opts.sessionId !== undefined) {
    // A prefix resolves to the full id, so later lookups keyed on it match.
    const r = lookupSession(sources, opts.sessionId);
    return r.ok ? { sessionId: r.sessionId, source: r.source, via: 'flag' } : undefined;
  }

  // Fall through if neither variable is set; never invent an id.
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

/** Every discoverable session with its size and mtime. A file that vanishes mid-scan is skipped. */
export function sessionSizes(sources: string[]): { id: string; sizeBytes: number; mtimeMs: number }[] {
  const out: { id: string; sizeBytes: number; mtimeMs: number }[] = [];
  for (const source of discoverTranscripts(sources)) {
    try {
      const st = statSync(source);
      out.push({ id: basename(source, '.jsonl'), sizeBytes: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // gone between listing and stat
    }
  }
  return out;
}
