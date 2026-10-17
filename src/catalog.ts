/**
 * The catalog: incremental bookkeeping over transcripts we do **not** copy.
 *
 * ── Why there is no copy ─────────────────────────────────────────────────────
 *
 * An earlier design archived every transcript into our own store, justified by
 * the harness deleting them after `cleanupPeriodDays`. Two things killed it.
 *
 * First, honouring that retention policy — which we must, since outliving it
 * silently overrides the user's privacy decision — means a copy never survives
 * anything the original would not. It bought nothing.
 *
 * Second, and more important: **a transcript can contain a leaked token, an API
 * key pasted into a prompt, a `.env` echoed by a tool result.** That exposure
 * already exists in the harness's file. Copying it creates a *second* one, in a
 * directory we chose, with a lifetime we chose, that the user never asked for.
 * If that copy is read by the wrong process, synced, or swept into a backup,
 * the breach is ours — from data that was not ours to duplicate.
 *
 * So: read in place, remember only where we got to, and let what we persist be
 * derived and redacted. The smallest attack surface is the one that does not
 * exist.
 *
 * What is kept here is bytes-consumed bookkeeping — enough that a re-scan reads
 * only new data, and enough to notice when a source changes or disappears.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { basename, join, relative } from 'node:path';
import { SCHEMA, checkVersion, stamp, type Versioned } from './schema.ts';
import { detectVersion } from './parsers/registry.ts';

export type CatalogEntry = {
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
  /** When the source was first observed missing — the harness deleted it. */
  gone?: string;
};

export type Catalog = Versioned<'catalog'> & {
  createdAt: string;
  entries: Record<string, CatalogEntry>;
};

export type ScanStats = {
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

export function initCatalog(dir: string): Catalog {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is subject to umask. The catalog holds no transcript content,
  // but it does hold absolute paths, so owner-only remains the right default.
  chmodSync(dir, 0o700);

  const p = join(dir, INDEX_FILE);
  if (existsSync(p)) {
    try {
      const c = JSON.parse(readFileSync(p, 'utf8')) as Catalog;
      if (checkVersion('catalog', c.v).ok && c.entries) return c;
      // A version mismatch re-derives rather than guessing. Cheap now that the
      // only cost is re-reading sources we do not own.
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
  // Temp path then rename, so a kill cannot leave a half-written catalog.
  const target = join(dir, INDEX_FILE);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
  renameSync(tmp, target);
}

/** Recursively collect *.jsonl under the given roots. Missing roots are not errors. */
export function findTranscripts(sources: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable or absent — skip, never crash
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  for (const s of sources) walk(s);
  return out.sort();
}

function harnessFor(sourcePath: string): string {
  if (sourcePath.includes(join('.claude', 'projects'))) return 'claude-code';
  if (sourcePath.includes(join('.codex', 'sessions'))) return 'codex';
  return 'unknown';
}

/** Read a byte range without loading the whole file. */
function readRange(path: string, from: number, to: number): Buffer {
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

export type ScanOptions = {
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

  for (const source of findTranscripts(opts.sources)) {
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

    // Re-read from zero when the source shrank, OR when its mtime moved without
    // the size changing.
    //
    // That second case is a same-length rewrite, and it cannot be verified: we
    // deliberately keep no copy of the old bytes to compare against. Treating it
    // as "just a touch" silently misses the new content, so the conservative
    // read wins. It costs nothing in practice — appending to a JSONL always
    // changes its size, so mtime-moved-size-same means something really was
    // rewritten.
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

    // Advance only to the last complete line.
    //
    // The harness may be mid-write, leaving a partial trailing record. Consuming
    // it would skip that record permanently: the parser discards it as malformed
    // and we would never re-read the completed version. So the offset stops at
    // the final newline and the fragment is picked up on the next scan.
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

    // Hash is cumulative over consumed bytes, so a source rewritten underneath
    // us produces a different digest even at the same length.
    const sha256 = createHash('sha256')
      .update(prior?.sha256 ?? '')
      .update(complete)
      .digest('hex');

    const version = detectVersion(text.split('\n')) ?? prior?.version;

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
    };

    stats.bytesRead += consumed;
    if (rewritten) stats.reset++;
    else if (existing) stats.grown++;
    else stats.added++;
  }

  // Sources we knew about that are no longer on disk. The entry is kept —
  // findings reference it, and `explain` needs to be able to say *when* the
  // transcript went away rather than implying we lost it.
  for (const [key, e] of Object.entries(catalog.entries)) {
    if (seen.has(key) || e.gone !== undefined) continue;
    catalog.entries[key] = { ...e, gone: now() };
    stats.vanished++;
  }

  writeCatalog(opts.catalog, catalog);
  return stats;
}

export function readCatalog(dir: string): Catalog | undefined {
  try {
    const c = JSON.parse(readFileSync(join(dir, INDEX_FILE), 'utf8')) as Catalog;
    return checkVersion('catalog', c.v).ok ? c : undefined;
  } catch {
    return undefined;
  }
}

export const CATALOG_SCHEMA_VERSION = SCHEMA.catalog;

export function describeCatalog(dir: string): {
  sessions: number;
  gone: number;
  bytesTracked: number;
  oldest?: string;
  newest?: string;
} {
  const c = readCatalog(dir);
  if (!c) return { sessions: 0, gone: 0, bytesTracked: 0 };
  const entries = Object.values(c.entries);
  const times = entries.map((e) => e.firstSeenAt).sort();
  return {
    sessions: entries.length,
    gone: entries.filter((e) => e.gone !== undefined).length,
    // Bytes of source read, not bytes stored. We store none.
    bytesTracked: entries.reduce((n, e) => n + e.offset, 0),
    ...(times[0] !== undefined ? { oldest: times[0] } : {}),
    ...(times.at(-1) !== undefined ? { newest: times.at(-1) as string } : {}),
  };
}

/** For diagnostics: a source path relative to home, when it is under it. */
export function relativeSource(entry: CatalogEntry, home: string): string {
  const rel = relative(home, entry.source);
  return rel.startsWith('..') ? entry.source : `~/${rel}`;
}
