/**
 * The catalog: incremental bookkeeping (offsets, hashes, spans) over transcripts read in place.
 * Never copies transcripts: CLAUDE.md "Local and secure".
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, chmodSync } from 'node:fs';
import { basename, join } from 'node:path';
import { checkVersion, stamp, type Versioned } from './schema.ts';
import { discoverTranscripts, readRange } from './read.ts';
import { isPlausibleTimestamp } from './normalise.ts';
import { detectVersion } from './parsers/index.ts';
import { writeAtomic } from './files.ts';

type CatalogEntry = {
  /** Absolute path to the live JSONL. The only copy that exists. */
  source: string;
  sessionId: string;
  harness: string;
  /** Harness version read from the transcript, for parser dispatch. */
  version?: string;
  /** Bytes of the source consumed so far, always on a line boundary. */
  offset: number;
  size: number;
  mtimeMs: number;
  /** sha256 over the bytes consumed, so a source rewritten underneath us shows up. */
  sha256: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Earliest and latest record timestamp: the period the data covers, unlike `firstSeenAt`. */
  firstTs?: string;
  lastTs?: string;
  /** When the source was first observed missing — the harness deleted it. */
  gone?: string;
};

type Catalog = Versioned<'catalog'> & {
  createdAt: string;
  entries: Record<string, CatalogEntry>;
};

type ScanStats = {
  scanned: number;
  added: number;
  /** Sources that grew since the last scan. */
  grown: number;
  unchanged: number;
  /** Sources replaced or truncated in place — re-read from zero. */
  reset: number;
  /** Known sources no longer on disk. */
  vanished: number;
  bytesRead: number;
  skipped: { path: string; reason: string }[];
};

const INDEX_FILE = 'index.json';

function initCatalog(dir: string): Catalog {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is subject to umask; the catalog holds absolute paths.
  chmodSync(dir, 0o700);

  const p = join(dir, INDEX_FILE);
  if (existsSync(p)) {
    try {
      const c = JSON.parse(readFileSync(p, 'utf8')) as Catalog;
      if (checkVersion('catalog', c.v).ok && c.entries) return c;
      // Version mismatch: re-derive rather than guess.
    } catch {
      // A corrupt catalog costs a re-read; refusing to run costs the user data.
    }
  }
  const fresh: Catalog = {
    ...stamp('catalog'),
    createdAt: new Date().toISOString(),
    entries: {},
  };
  writeCatalog(dir, fresh);
  return fresh;
}

function writeCatalog(dir: string, c: Catalog): void {
  writeAtomic(join(dir, INDEX_FILE), JSON.stringify(c, null, 2));
}

function harnessFor(sourcePath: string): string {
  if (sourcePath.includes(join('.claude', 'projects'))) return 'claude-code';
  if (sourcePath.includes(join('.codex', 'sessions'))) return 'codex';
  return 'unknown';
}

type ScanOptions = {
  sources: string[];
  catalog: string;
  now?: () => string;
};

/**
 * One incremental pass. Returns what changed, so `scan && scan` can be asserted
 * to read zero redundant bytes.
 */
export function runScan(opts: ScanOptions): ScanStats {
  const now = opts.now ?? (() => new Date().toISOString());
  const catalog = initCatalog(opts.catalog);

  const stats: ScanStats = {
    scanned: 0,
    added: 0,
    grown: 0,
    unchanged: 0,
    reset: 0,
    vanished: 0,
    bytesRead: 0,
    skipped: [],
  };

  const seen = new Set<string>();

  for (const source of discoverTranscripts(opts.sources)) {
    stats.scanned++;
    seen.add(source);

    let st;
    try {
      st = statSync(source);
    } catch {
      stats.skipped.push({ path: source, reason: 'unreadable' });
      continue;
    }

    const existing = catalog.entries[source];

    // Cheap no-op: nothing new since last time.
    if (existing && st.size === existing.offset && st.mtimeMs === existing.mtimeMs) {
      stats.unchanged++;
      continue;
    }

    // Re-read from zero if the source shrank or its mtime moved at the same size
    // (a rewrite we cannot verify, since we keep no copy).
    const rewritten =
      existing !== undefined && (st.size < existing.offset || st.size === existing.offset);
    const from = rewritten || !existing ? 0 : existing.offset;

    let chunk: Buffer;
    try {
      chunk = readRange(source, from, st.size);
    } catch {
      stats.skipped.push({ path: source, reason: 'read-failed' });
      continue;
    }
    if (chunk.length === 0) {
      stats.unchanged++;
      continue;
    }

    // Advance only to the last complete line; a partial record from a mid-write
    // would otherwise be skipped for good.
    const lastNl = chunk.lastIndexOf(0x0a);
    if (lastNl === -1) {
      // No complete line in this chunk yet — leave the offset alone entirely.
      stats.unchanged++;
      continue;
    }
    const consumed = lastNl + 1;
    const complete = chunk.subarray(0, consumed);

    const text = complete.toString('utf8');
    const ts = now();
    const prior = rewritten ? undefined : existing;

    // Cumulative over consumed bytes, so a rewrite changes the digest.
    const sha256 = createHash('sha256')
      .update(prior?.sha256 ?? '')
      .update(complete)
      .digest('hex');

    const version = detectVersion(text.split('\n')) ?? prior?.version;

    // Span without building events: this is the cheap pass.
    const span = timestampSpan(text);
    const firstTs = minIso(prior?.firstTs, span.first);
    const lastTs = maxIso(prior?.lastTs, span.last);

    catalog.entries[source] = {
      source,
      sessionId: basename(source, '.jsonl'),
      harness: harnessFor(source),
      ...(version !== undefined ? { version } : {}),
      offset: from + consumed,
      size: st.size,
      mtimeMs: st.mtimeMs,
      sha256,
      firstSeenAt: prior?.firstSeenAt ?? ts,
      lastSeenAt: ts,
      ...(firstTs !== undefined ? { firstTs } : {}),
      ...(lastTs !== undefined ? { lastTs } : {}),
    };

    stats.bytesRead += consumed;
    if (rewritten) stats.reset++;
    else if (existing) stats.grown++;
    else stats.added++;
  }

  // Vanished sources keep their entry, marked `gone`, so we can say when they went.
  for (const [key, e] of Object.entries(catalog.entries)) {
    if (seen.has(key) || e.gone !== undefined) continue;
    catalog.entries[key] = { ...e, gone: now() };
    stats.vanished++;
  }

  writeCatalog(opts.catalog, catalog);
  return stats;
}

/**
 * Earliest and latest top-level `timestamp` in a chunk of JSONL. Parsed per line, not regexed:
 * tool output can contain `"timestamp"`. Malformed lines are skipped.
 */
function timestampSpan(text: string): { first?: string; last?: string } {
  let first: string | undefined;
  let last: string | undefined;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    let ts: unknown;
    try {
      ts = (JSON.parse(line) as { timestamp?: unknown }).timestamp;
    } catch {
      continue;
    }
    if (!isPlausibleTimestamp(ts)) continue;
    // Lexicographic order is correct for UTC ISO-8601.
    if (first === undefined || ts < first) first = ts;
    if (last === undefined || ts > last) last = ts;
  }
  return { ...(first !== undefined ? { first } : {}), ...(last !== undefined ? { last } : {}) };
}


function minIso(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a < b ? a : b;
}

function maxIso(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a > b ? a : b;
}

export function readCatalog(dir: string): Catalog | undefined {
  try {
    const c = JSON.parse(readFileSync(join(dir, INDEX_FILE), 'utf8')) as Catalog;
    return checkVersion('catalog', c.v).ok ? c : undefined;
  } catch {
    return undefined;
  }
}

export function describeCatalog(dir: string): {
  sessions: number;
  gone: number;
  bytesTracked: number;
  /** When we first looked. */
  oldest?: string;
  newest?: string;
  /** The period the catalogued transcripts actually cover. */
  dataFrom?: string;
  dataTo?: string;
  /** One interval per session, so gaps between sessions stay visible. */
  spans: { from: string; to: string }[];
} {
  const c = readCatalog(dir);
  if (!c) return { sessions: 0, gone: 0, bytesTracked: 0, spans: [] };
  const entries = Object.values(c.entries);
  const times = entries.map((e) => e.firstSeenAt).sort();
  let dataFrom: string | undefined;
  let dataTo: string | undefined;
  const spans: { from: string; to: string }[] = [];
  for (const e of entries) {
    dataFrom = minIso(dataFrom, e.firstTs);
    dataTo = maxIso(dataTo, e.lastTs);
    if (e.firstTs !== undefined && e.lastTs !== undefined) {
      spans.push({ from: e.firstTs, to: e.lastTs });
    }
  }
  return {
    sessions: entries.length,
    gone: entries.filter((e) => e.gone !== undefined).length,
    // Bytes of source read, not bytes stored. We store none.
    bytesTracked: entries.reduce((n, e) => n + e.offset, 0),
    ...(times[0] !== undefined ? { oldest: times[0] } : {}),
    ...(times.at(-1) !== undefined ? { newest: times.at(-1) as string } : {}),
    ...(dataFrom !== undefined ? { dataFrom } : {}),
    ...(dataTo !== undefined ? { dataTo } : {}),
    spans,
  };
}
