import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  rmSync,
  statSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runScan, readCatalog, findTranscripts, describeCatalog } from '../src/catalog.ts';
import { SCHEMA } from '../src/schema.ts';

let root: string;
let sources: string;
let catalog: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentsensei-test-'));
  sources = join(root, '.claude', 'projects');
  catalog = join(root, 'store');
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

describe('catalog — copies nothing', () => {
  it('stores only index.json, never a transcript', () => {
    // The whole point of the design. A leaked token in a transcript is already
    // exposed in the harness's file; duplicating it would make that our breach.
    session('aaa', ['{"a":1}', '{"a":2}']);
    runScan({ sources: [sources], catalog });

    expect(readdirSync(catalog)).toEqual(['index.json']);
    expect(existsSync(join(catalog, 'sessions'))).toBe(false);
  });

  it('keeps the catalog orders of magnitude smaller than the sources', () => {
    const big = Array.from({ length: 500 }, (_, i) => `{"n":${i},"pad":"${'x'.repeat(200)}"}`);
    const p = session('big', big);
    runScan({ sources: [sources], catalog });

    const sourceBytes = statSync(p).size;
    const catalogBytes = statSync(join(catalog, 'index.json')).size;
    expect(sourceBytes).toBeGreaterThan(100_000);
    expect(catalogBytes).toBeLessThan(sourceBytes / 50);
  });

  it('points back at the source rather than holding a path of its own', () => {
    const p = session('aaa', ['{"a":1}']);
    runScan({ sources: [sources], catalog });
    const e = Object.values(readCatalog(catalog)!.entries)[0]!;
    expect(e.source).toBe(p);
    expect(e).not.toHaveProperty('archivePath');
  });
});

describe('catalog — incremental behaviour', () => {
  it('records new transcripts on first scan', () => {
    session('aaa', ['{"a":1}', '{"a":2}']);
    const s = runScan({ sources: [sources], catalog });
    expect(s.added).toBe(1);
    expect(s.bytesRead).toBeGreaterThan(0);
  });

  it('reads ZERO redundant bytes on an unchanged re-scan', () => {
    session('aaa', ['{"a":1}', '{"a":2}']);
    expect(runScan({ sources: [sources], catalog }).bytesRead).toBeGreaterThan(0);

    const second = runScan({ sources: [sources], catalog });
    expect(second.bytesRead).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(second.added).toBe(0);
    expect(second.grown).toBe(0);
  });

  it('reads only the new bytes when a session grows', () => {
    const p = session('aaa', ['{"a":1}']);
    runScan({ sources: [sources], catalog });

    const added = '{"a":2}\n';
    appendFileSync(p, added);
    const s = runScan({ sources: [sources], catalog });

    expect(s.grown).toBe(1);
    expect(s.bytesRead).toBe(Buffer.byteLength(added));
    expect(Object.values(readCatalog(catalog)!.entries)[0]!.offset).toBe(statSync(p).size);
  });

  it('re-reads from zero when a source is truncated', () => {
    const p = session('aaa', ['{"a":1}', '{"a":2}', '{"a":3}']);
    runScan({ sources: [sources], catalog });

    writeFileSync(p, '{"b":1}\n'); // replaced in place, now shorter
    const s = runScan({ sources: [sources], catalog });

    expect(s.reset).toBe(1);
    expect(Object.values(readCatalog(catalog)!.entries)[0]!.offset).toBe(8);
  });

  it('captures the harness version for parser dispatch', () => {
    session('aaa', [
      '{"type":"mode","mode":"default"}',
      '{"type":"user","uuid":"a","version":"2.1.296","message":{"content":"hi"}}',
    ]);
    runScan({ sources: [sources], catalog });
    expect(Object.values(readCatalog(catalog)!.entries)[0]!.version).toBe('2.1.296');
  });
});

describe('catalog — line boundaries', () => {
  it('does NOT consume a partial trailing line', () => {
    // The harness may be mid-write. Consuming a fragment would skip that record
    // permanently: the parser discards it as malformed and the completed version
    // is never re-read.
    const p = session('aaa', ['{"a":1}']);
    appendFileSync(p, '{"a":2,"incomp'); // no newline

    const s = runScan({ sources: [sources], catalog });
    expect(s.bytesRead).toBe(8); // only the first complete line
    expect(Object.values(readCatalog(catalog)!.entries)[0]!.offset).toBe(8);
  });

  it('picks the fragment up once it is completed', () => {
    const p = session('aaa', ['{"a":1}']);
    appendFileSync(p, '{"a":2,"incomp');
    runScan({ sources: [sources], catalog });

    appendFileSync(p, 'lete":false}\n'); // the write finishes
    const s = runScan({ sources: [sources], catalog });

    expect(s.grown).toBe(1);
    const e = Object.values(readCatalog(catalog)!.entries)[0]!;
    expect(e.offset).toBe(statSync(p).size);
    // and the completed record is readable from the source
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    expect(JSON.parse(lines[1] as string)).toEqual({ a: 2, incomplete: false });
  });

  it('advances nothing when no complete line exists yet', () => {
    const dir = join(sources, '-Users-test-Workspace');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'partial.jsonl'), '{"half":');

    const s = runScan({ sources: [sources], catalog });
    expect(s.bytesRead).toBe(0);
    expect(readCatalog(catalog)!.entries).toEqual({});
  });
});

describe('catalog — the source is the only copy', () => {
  it('records when the harness deletes a source, and keeps the entry', () => {
    // Findings outlive transcripts, so `explain` needs to say *when* the
    // transcript went away rather than implying we lost it.
    const p = session('aaa', ['{"a":1}']);
    runScan({ sources: [sources], catalog });
    rmSync(p);

    const s = runScan({ sources: [sources], catalog, now: () => '2026-10-17T00:00:00.000Z' });
    expect(s.vanished).toBe(1);
    const e = Object.values(readCatalog(catalog)!.entries)[0]!;
    expect(e.gone).toBe('2026-10-17T00:00:00.000Z');
    expect(describeCatalog(catalog).gone).toBe(1);
  });

  it('does not re-stamp `gone` on later scans', () => {
    const p = session('aaa', ['{"a":1}']);
    runScan({ sources: [sources], catalog });
    rmSync(p);
    runScan({ sources: [sources], catalog, now: () => '2026-10-17T00:00:00.000Z' });
    const s = runScan({ sources: [sources], catalog, now: () => '2026-10-18T00:00:00.000Z' });
    expect(s.vanished).toBe(0);
    expect(Object.values(readCatalog(catalog)!.entries)[0]!.gone).toBe('2026-10-17T00:00:00.000Z');
  });

  it('never writes to the source', () => {
    const p = session('aaa', ['{"a":1}']);
    const before = statSync(p).mtimeMs;
    runScan({ sources: [sources], catalog });
    expect(statSync(p).mtimeMs).toBe(before);
  });
});

describe('catalog — robustness', () => {
  it('creates the store 0700', () => {
    session('aaa', ['{"a":1}']);
    runScan({ sources: [sources], catalog });
    expect(statSync(catalog).mode & 0o777).toBe(0o700);
  });

  it('skips unreadable sources instead of crashing', () => {
    session('aaa', ['{"a":1}']);
    const s = runScan({ sources: [sources, join(root, 'nope')], catalog });
    expect(s.added).toBe(1);
  });

  it('rebuilds a corrupt catalog rather than failing', () => {
    session('aaa', ['{"a":1}']);
    runScan({ sources: [sources], catalog });
    writeFileSync(join(catalog, 'index.json'), 'not json');
    expect(() => runScan({ sources: [sources], catalog })).not.toThrow();
    expect(readCatalog(catalog)?.v).toBe(SCHEMA.catalog);
  });

  it('is self-describing on disk', () => {
    session('aaa', ['{"a":1}']);
    runScan({ sources: [sources], catalog });
    const raw = JSON.parse(readFileSync(join(catalog, 'index.json'), 'utf8'));
    expect(raw).toMatchObject({ tool: 'agentsensei', schema: 'catalog', v: SCHEMA.catalog });
  });

  it('re-derives rather than trusting a catalog from a NEWER version', () => {
    session('aaa', ['{"a":1}']);
    runScan({ sources: [sources], catalog });
    const p = join(catalog, 'index.json');
    const idx = JSON.parse(readFileSync(p, 'utf8'));
    idx.v = SCHEMA.catalog + 1;
    writeFileSync(p, JSON.stringify(idx));

    const s = runScan({ sources: [sources], catalog });
    expect(s.added).toBe(1); // read again from scratch
    expect(readCatalog(catalog)?.v).toBe(SCHEMA.catalog);
  });

  it('changes the hash when a source is rewritten at the same length', () => {
    const p = session('aaa', ['{"a":1}']);
    runScan({ sources: [sources], catalog });
    const first = Object.values(readCatalog(catalog)!.entries)[0]!.sha256;

    writeFileSync(p, '{"a":9}\n'); // same length, different content
    runScan({ sources: [sources], catalog });
    expect(Object.values(readCatalog(catalog)!.entries)[0]!.sha256).not.toBe(first);
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

describe('catalog — the period a transcript covers', () => {
  // The report's depth labelling rests entirely on these fields, and none of the
  // 22 tests above touched them.
  const rec = (ts: string, extra = ''): string =>
    `{"type":"user","uuid":"u${ts}","timestamp":"${ts}"${extra}}`;

  it('records the first and last record timestamp', () => {
    session('aaa', [rec('2026-10-12T10:00:00.000Z'), rec('2026-10-14T18:30:00.000Z')]);
    runScan({ sources: [sources], catalog });
    const e = Object.values(readCatalog(catalog)!.entries)[0]!;
    expect(e.firstTs).toBe('2026-10-12T10:00:00.000Z');
    expect(e.lastTs).toBe('2026-10-14T18:30:00.000Z');
  });

  it('distinguishes the data span from when we first looked', () => {
    // `firstSeenAt` is when we read the file; `firstTs` is what it covers. Using
    // the former as a depth boundary claimed coverage of only the scan day.
    session('aaa', [rec('2026-08-23T03:48:00.000Z')]);
    runScan({ sources: [sources], catalog, now: () => '2026-10-19T00:00:00.000Z' });
    const e = Object.values(readCatalog(catalog)!.entries)[0]!;
    expect(e.firstSeenAt).toBe('2026-10-19T00:00:00.000Z');
    expect(e.firstTs).toBe('2026-08-23T03:48:00.000Z');
  });

  it('IGNORES a timestamp echoed inside a tool result', () => {
    // The regex this replaced matched any "timestamp" anywhere in the line, so
    // one pasted CI log would set firstTs to 2019 and make `report` claim full
    // depth across years holding nothing.
    const echoed =
      '{"type":"user","uuid":"b","timestamp":"2026-10-12T10:00:05.000Z",' +
      '"message":{"content":[{"type":"tool_result","tool_use_id":"t1",' +
      '"content":"{\\"timestamp\\": \\"2019-03-04T00:00:00.000Z\\", \\"level\\": \\"warn\\"}"}]}}';
    session('aaa', [rec('2026-10-12T10:00:00.000Z'), echoed]);
    runScan({ sources: [sources], catalog });
    const e = Object.values(readCatalog(catalog)!.entries)[0]!;
    expect(e.firstTs).toBe('2026-10-12T10:00:00.000Z');
    expect(e.firstTs?.startsWith('2019')).toBe(false);
  });

  it('rejects an implausible timestamp rather than trusting it', () => {
    session('aaa', [rec('1999-01-01T00:00:00.000Z'), rec('2026-10-12T10:00:00.000Z')]);
    runScan({ sources: [sources], catalog });
    expect(Object.values(readCatalog(catalog)!.entries)[0]!.firstTs).toBe(
      '2026-10-12T10:00:00.000Z',
    );
  });

  it('widens the span incrementally, keeping the earliest across scans', () => {
    // Only new bytes are read on a grown file, so the earliest timestamp has to
    // come from the stored value — the case most likely to be wrong and least
    // likely to be noticed, since a wrong firstTs still looks plausible.
    const p = session('aaa', [rec('2026-10-12T10:00:00.000Z')]);
    runScan({ sources: [sources], catalog });
    appendFileSync(p, `${rec('2026-10-15T09:00:00.000Z')}\n`);
    const s = runScan({ sources: [sources], catalog });

    expect(s.grown).toBe(1);
    const e = Object.values(readCatalog(catalog)!.entries)[0]!;
    expect(e.firstTs).toBe('2026-10-12T10:00:00.000Z'); // from the first scan
    expect(e.lastTs).toBe('2026-10-15T09:00:00.000Z'); // from the second
  });

  it('exposes one span per session so gaps stay visible', () => {
    session('aug', [rec('2026-08-23T03:48:00.000Z'), rec('2026-08-23T03:49:00.000Z')]);
    session('oct', [rec('2026-10-12T10:00:00.000Z'), rec('2026-10-19T02:00:00.000Z')]);
    runScan({ sources: [sources], catalog });

    const d = describeCatalog(catalog);
    expect(d.spans).toHaveLength(2);
    expect(d.dataFrom).toBe('2026-08-23T03:48:00.000Z');
    expect(d.dataTo).toBe('2026-10-19T02:00:00.000Z');
    // The September gap exists between the two spans, not inside either.
    const sorted = [...d.spans].sort((a, b) => a.from.localeCompare(b.from));
    expect(sorted[0]!.to < sorted[1]!.from).toBe(true);
  });

  it('omits the span for a transcript with no usable timestamps', () => {
    session('aaa', ['{"type":"user","uuid":"a"}']);
    runScan({ sources: [sources], catalog });
    const e = Object.values(readCatalog(catalog)!.entries)[0]!;
    expect(e.firstTs).toBeUndefined();
    expect(describeCatalog(catalog).spans).toHaveLength(0);
  });
});
