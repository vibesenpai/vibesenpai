/**
 * The archiver. Runs before the parser, because the data substrate is being
 * deleted: Claude Code's `cleanupPeriodDays` defaults to 30 days, and on the
 * development machine it had already removed 39 of 41 sessions.
 *
 * Append-only, content-hashed, byte-offset + mtime tracked, so a re-run reads
 * only new bytes. Everything downstream reads the archive, never the live dir.
 *
 * The archive is RAW and UNREDACTED by design — redaction happens at parse and
 * display time, so the preserved copy stays byte-faithful and a redactor bug can
 * never destroy evidence. Consequences are handled here: 0700, and a refusal to
 * initialise inside a known sync root.
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
  appendFileSync,
  chmodSync,
} from 'node:fs';
import { basename, join, relative } from 'node:path';
import { isInsideSyncRoot } from './config.ts';

export const ARCHIVE_FORMAT = 1 as const;

export type IndexEntry = {
  /** Absolute path of the source transcript. */
  source: string;
  sessionId: string;
  harness: string;
  /** Bytes of the SOURCE consumed so far. */
  offset: number;
  /** Source size and mtime at last read, for the cheap no-op check. */
  size: number;
  mtimeMs: number;
  /** sha256 of everything archived for this session, for integrity. */
  sha256: string;
  archivePath: string;
  firstArchivedAt: string;
  lastArchivedAt: string;
};

export type ArchiveIndex = {
  format: typeof ARCHIVE_FORMAT;
  createdAt: string;
  entries: Record<string, IndexEntry>;
};

export type ArchiveStats = {
  scanned: number;
  added: number;
  appended: number;
  unchanged: number;
  reset: number;
  bytesRead: number;
  skipped: { path: string; reason: string }[];
};

const INDEX_FILE = 'index.json';
const SESSIONS_DIR = 'sessions';

export class SyncRootRefusal extends Error {
  constructor(path: string) {
    super(
      `refusing to initialise the archive inside a sync root: ${path}\n` +
        `The archive holds raw, unredacted transcripts. Choose another location with ` +
        `--archive <path> or AGENTSENSEI_ARCHIVE, or pass allowSyncRoot to override.`,
    );
    this.name = 'SyncRootRefusal';
  }
}

export function initArchive(
  archiveDir: string,
  opts: { home?: string; allowSyncRoot?: boolean } = {},
): ArchiveIndex {
  if (!opts.allowSyncRoot && isInsideSyncRoot(archiveDir, opts.home)) {
    throw new SyncRootRefusal(archiveDir);
  }

  mkdirSync(join(archiveDir, SESSIONS_DIR), { recursive: true, mode: 0o700 });
  // mkdir's mode is subject to umask, so assert it explicitly.
  chmodSync(archiveDir, 0o700);

  const indexPath = join(archiveDir, INDEX_FILE);
  if (existsSync(indexPath)) {
    try {
      const idx = JSON.parse(readFileSync(indexPath, 'utf8')) as ArchiveIndex;
      if (idx.format === ARCHIVE_FORMAT && idx.entries) return idx;
    } catch {
      // Fall through and rebuild rather than failing: a corrupt index costs a
      // re-read, while refusing to run costs the user their data.
    }
  }
  const fresh: ArchiveIndex = {
    format: ARCHIVE_FORMAT,
    createdAt: new Date().toISOString(),
    entries: {},
  };
  writeIndex(archiveDir, fresh);
  return fresh;
}

function writeIndex(archiveDir: string, index: ArchiveIndex): void {
  // Write to a temp path and rename, so a kill cannot leave a half-written index.
  const target = join(archiveDir, INDEX_FILE);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(index, null, 2), { mode: 0o600 });
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
  if (sourcePath.includes(`${join('.claude', 'projects')}`)) return 'claude-code';
  if (sourcePath.includes(`${join('.codex', 'sessions')}`)) return 'codex';
  return 'unknown';
}

/** Read a byte range from a file without loading the whole thing. */
function readRange(path: string, from: number, to: number): Buffer {
  const len = to - from;
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

export type ArchiveOptions = {
  sources: string[];
  archive: string;
  home?: string;
  allowSyncRoot?: boolean;
  now?: () => string;
};

/**
 * Incremental archive pass. Returns what it did, so `archive && archive` can be
 * asserted to read zero redundant bytes on the second run.
 */
export function runArchive(opts: ArchiveOptions): ArchiveStats {
  const now = opts.now ?? (() => new Date().toISOString());
  const index = initArchive(opts.archive, {
    ...(opts.home !== undefined ? { home: opts.home } : {}),
    ...(opts.allowSyncRoot !== undefined ? { allowSyncRoot: opts.allowSyncRoot } : {}),
  });

  const stats: ArchiveStats = {
    scanned: 0,
    added: 0,
    appended: 0,
    unchanged: 0,
    reset: 0,
    bytesRead: 0,
    skipped: [],
  };

  for (const source of findTranscripts(opts.sources)) {
    stats.scanned++;

    let st;
    try {
      st = statSync(source);
    } catch {
      stats.skipped.push({ path: source, reason: 'unreadable' });
      continue;
    }

    const sessionId = basename(source, '.jsonl');
    const key = source;
    const existing = index.entries[key];
    const archivePath = join(opts.archive, SESSIONS_DIR, `${sessionId}.jsonl`);

    // Cheap no-op: nothing new to read.
    if (existing && st.size === existing.offset && st.mtimeMs === existing.mtimeMs) {
      stats.unchanged++;
      continue;
    }

    // Truncated or replaced in place — the offset no longer means anything.
    const truncated = existing !== undefined && st.size < existing.offset;
    const from = truncated || !existing ? 0 : existing.offset;

    if (truncated) {
      stats.reset++;
      try {
        writeFileSync(archivePath, '', { mode: 0o600 });
      } catch {
        stats.skipped.push({ path: source, reason: 'archive-not-writable' });
        continue;
      }
    }

    if (st.size === from) {
      // Size matches our offset but mtime moved (e.g. a touch). Nothing to read.
      index.entries[key] = { ...(existing as IndexEntry), mtimeMs: st.mtimeMs, size: st.size };
      stats.unchanged++;
      continue;
    }

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

    try {
      if (from === 0) writeFileSync(archivePath, chunk, { mode: 0o600 });
      else appendFileSync(archivePath, chunk);
    } catch {
      stats.skipped.push({ path: source, reason: 'archive-not-writable' });
      continue;
    }

    // Hash the archived content so integrity can be checked independently of
    // the source, which may be deleted at any time.
    const sha256 = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
    const ts = now();

    index.entries[key] = {
      source,
      sessionId,
      harness: harnessFor(source),
      offset: from + chunk.length,
      size: st.size,
      mtimeMs: st.mtimeMs,
      sha256,
      archivePath,
      firstArchivedAt: existing?.firstArchivedAt ?? ts,
      lastArchivedAt: ts,
    };

    stats.bytesRead += chunk.length;
    if (existing && !truncated) stats.appended++;
    else stats.added++;
  }

  writeIndex(opts.archive, index);
  return stats;
}

export function readIndex(archiveDir: string): ArchiveIndex | undefined {
  try {
    return JSON.parse(readFileSync(join(archiveDir, INDEX_FILE), 'utf8')) as ArchiveIndex;
  } catch {
    return undefined;
  }
}

export function describeArchive(archiveDir: string): {
  sessions: number;
  bytes: number;
  oldest?: string;
  newest?: string;
} {
  const index = readIndex(archiveDir);
  if (!index) return { sessions: 0, bytes: 0 };
  const entries = Object.values(index.entries);
  let bytes = 0;
  for (const e of entries) {
    try {
      bytes += statSync(e.archivePath).size;
    } catch {
      /* archived file removed under us; report what we can */
    }
  }
  const times = entries.map((e) => e.firstArchivedAt).sort();
  return {
    sessions: entries.length,
    bytes,
    ...(times[0] !== undefined ? { oldest: times[0] } : {}),
    ...(times.at(-1) !== undefined ? { newest: times.at(-1) as string } : {}),
  };
}

/** For diagnostics: where an archived session came from, relative to a root. */
export function relativeSource(entry: IndexEntry, home: string): string {
  const rel = relative(home, entry.source);
  return rel.startsWith('..') ? entry.source : `~/${rel}`;
}
