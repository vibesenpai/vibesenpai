import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runArchive, readIndex, findTranscripts, SyncRootRefusal } from '../src/archive.ts';

let root: string;
let sources: string;
let archive: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentsensei-test-'));
  sources = join(root, 'projects');
  archive = join(root, 'archive');
  mkdirSync(sources, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function session(name: string, lines: string[]): string {
  const dir = join(sources, '-Users-test-Workspace');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${name}.jsonl`);
  writeFileSync(p, lines.map((l) => `${l}\n`).join(''));
  return p;
}

describe('archive — incremental behaviour', () => {
  it('archives new transcripts on first run', () => {
    session('aaa', ['{"type":"user"}', '{"type":"assistant"}']);
    const s = runArchive({ sources: [sources], archive });
    expect(s.added).toBe(1);
    expect(s.bytesRead).toBeGreaterThan(0);
    expect(readIndex(archive)?.entries).toBeDefined();
  });

  it('reads ZERO redundant bytes on an unchanged re-run', () => {
    session('aaa', ['{"a":1}', '{"a":2}']);
    const first = runArchive({ sources: [sources], archive });
    expect(first.bytesRead).toBeGreaterThan(0);

    const second = runArchive({ sources: [sources], archive });
    expect(second.bytesRead).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(second.added).toBe(0);
    expect(second.appended).toBe(0);
  });

  it('appends only the new bytes when a session grows', () => {
    const p = session('aaa', ['{"a":1}']);
    runArchive({ sources: [sources], archive });

    const added = '{"a":2}\n';
    appendFileSync(p, added);
    const s = runArchive({ sources: [sources], archive });

    expect(s.appended).toBe(1);
    expect(s.bytesRead).toBe(Buffer.byteLength(added));

    const archived = readFileSync(join(archive, 'sessions', 'aaa.jsonl'), 'utf8');
    expect(archived).toBe('{"a":1}\n{"a":2}\n');
  });

  it('re-archives from scratch when a source is truncated', () => {
    const p = session('aaa', ['{"a":1}', '{"a":2}', '{"a":3}']);
    runArchive({ sources: [sources], archive });

    writeFileSync(p, '{"b":1}\n'); // replaced in place, now smaller
    const s = runArchive({ sources: [sources], archive });

    expect(s.reset).toBe(1);
    expect(readFileSync(join(archive, 'sessions', 'aaa.jsonl'), 'utf8')).toBe('{"b":1}\n');
  });

  it('survives the source being deleted — the archive is the durable copy', () => {
    const p = session('aaa', ['{"a":1}']);
    runArchive({ sources: [sources], archive });
    rmSync(p);

    const s = runArchive({ sources: [sources], archive });
    expect(s.scanned).toBe(0);
    expect(readFileSync(join(archive, 'sessions', 'aaa.jsonl'), 'utf8')).toBe('{"a":1}\n');
  });

  it('records a content hash of the archived copy', () => {
    session('aaa', ['{"a":1}']);
    runArchive({ sources: [sources], archive });
    const entry = Object.values(readIndex(archive)!.entries)[0]!;
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('archive — safety', () => {
  it('creates the archive 0700, owner-only', () => {
    session('aaa', ['{"a":1}']);
    runArchive({ sources: [sources], archive });
    expect(statSync(archive).mode & 0o777).toBe(0o700);
  });

  it('refuses to initialise inside a sync root', () => {
    const home = join(root, 'home');
    const icloud = join(home, 'Library', 'Mobile Documents', 'agentsensei');
    mkdirSync(icloud, { recursive: true });
    expect(() => runArchive({ sources: [sources], archive: icloud, home })).toThrow(
      SyncRootRefusal,
    );
  });

  it('allows a sync root only with an explicit override', () => {
    const home = join(root, 'home');
    const dropbox = join(home, 'Dropbox', 'agentsensei');
    session('aaa', ['{"a":1}']);
    expect(() =>
      runArchive({ sources: [sources], archive: dropbox, home, allowSyncRoot: true }),
    ).not.toThrow();
  });

  it('never writes to the source directory', () => {
    const p = session('aaa', ['{"a":1}']);
    const before = statSync(p).mtimeMs;
    runArchive({ sources: [sources], archive });
    expect(statSync(p).mtimeMs).toBe(before);
  });

  it('skips unreadable sources instead of crashing', () => {
    session('aaa', ['{"a":1}']);
    const s = runArchive({ sources: [sources, join(root, 'does-not-exist')], archive });
    expect(s.added).toBe(1);
  });

  it('rebuilds a corrupt index rather than failing', () => {
    session('aaa', ['{"a":1}']);
    runArchive({ sources: [sources], archive });
    writeFileSync(join(archive, 'index.json'), 'not json at all');
    expect(() => runArchive({ sources: [sources], archive })).not.toThrow();
    expect(readIndex(archive)?.format).toBe(1);
  });
});

describe('findTranscripts', () => {
  it('finds .jsonl recursively and ignores everything else', () => {
    session('aaa', ['{}']);
    const nested = join(sources, '-Users-test-other', 'deep');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'bbb.jsonl'), '{}\n');
    writeFileSync(join(nested, 'notes.md'), 'ignore me\n');

    const found = findTranscripts([sources]);
    expect(found).toHaveLength(2);
    expect(found.every((f) => f.endsWith('.jsonl'))).toBe(true);
  });

  it('returns empty for a missing root without throwing', () => {
    expect(findTranscripts([join(root, 'nope')])).toEqual([]);
  });
});
