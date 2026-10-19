import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readSession,
  findSessionSource,
  findLatestSession,
  resolveCurrentSession,
} from '../src/read.ts';

let root: string;
let sources: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentsensei-read-'));
  sources = join(root, '.claude', 'projects', '-Users-test-proj');
  mkdirSync(sources, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function session(name: string, lines: string[]): string {
  const p = join(sources, `${name}.jsonl`);
  writeFileSync(p, lines.map((l) => `${l}\n`).join(''));
  return p;
}

const SOURCES = (): string[] => [join(root, '.claude', 'projects')];

describe('readSession — two modes, one reader', () => {
  it('catalogued stops at the recorded offset', () => {
    const p = session('aaa', ['{"a":1}', '{"a":2}', '{"a":3}']);
    const r = readSession({ source: p, mode: 'catalogued', catalogOffset: 8 });
    expect(r.text).toBe('{"a":1}\n');
    expect(r.bytesRead).toBe(8);
    expect(r.ahead).toBe(0);
  });

  it('live reads past the recorded offset and says how far', () => {
    // The whole point of `now`: the turns since the last scan are the ones you
    // just made.
    const p = session('aaa', ['{"a":1}', '{"a":2}', '{"a":3}']);
    const r = readSession({ source: p, mode: 'live', catalogOffset: 8 });
    expect(r.bytesRead).toBe(statSync(p).size);
    expect(r.ahead).toBe(16);
  });

  it('refuses a catalogued read with no offset instead of returning nothing', () => {
    // A silent empty result is indistinguishable from an empty session.
    const p = session('aaa', ['{"a":1}']);
    expect(() => readSession({ source: p, mode: 'catalogued' })).toThrow(/not in the catalog/);
  });

  it('live needs no offset at all — the normal state of a running session', () => {
    const p = session('aaa', ['{"a":1}']);
    const r = readSession({ source: p, mode: 'live' });
    expect(r.text).toBe('{"a":1}\n');
    expect(r.catalogOffset).toBeUndefined();
    expect(r.ahead).toBe(0);
  });

  it('never hands a partial trailing line to the parser', () => {
    const p = session('aaa', ['{"a":1}']);
    appendFileSync(p, '{"a":2,"incomp');
    const r = readSession({ source: p, mode: 'live' });
    expect(r.text).toBe('{"a":1}\n');
    expect(r.partialTail).toBe(true);
  });

  it('reads nothing when no complete line exists yet', () => {
    const p = join(sources, 'partial.jsonl');
    writeFileSync(p, '{"half":');
    const r = readSession({ source: p, mode: 'live' });
    expect(r.text).toBe('');
    expect(r.partialTail).toBe(true);
  });

  it('clamps an offset that outran the file', () => {
    // A source replaced by a shorter one must not read past its end.
    const p = session('aaa', ['{"a":1}']);
    const r = readSession({ source: p, mode: 'catalogued', catalogOffset: 9999 });
    expect(r.bytesRead).toBe(8);
  });

  it('derives the session id from the filename when not given', () => {
    const p = session('abc-123', ['{"a":1}']);
    expect(readSession({ source: p, mode: 'live' }).sessionId).toBe('abc-123');
  });

  it('never writes to the source', () => {
    const p = session('aaa', ['{"a":1}']);
    const before = statSync(p).mtimeMs;
    readSession({ source: p, mode: 'live' });
    expect(statSync(p).mtimeMs).toBe(before);
  });
});

describe('finding a session', () => {
  it('locates a transcript by id without consulting the catalog', () => {
    // `--live` has to work on a session no scan has reached, which is the normal
    // state of the one you are sitting in.
    const p = session('target', ['{"a":1}']);
    expect(findSessionSource(SOURCES(), 'target')).toBe(p);
  });

  it('returns undefined for an unknown id rather than guessing', () => {
    session('aaa', ['{"a":1}']);
    expect(findSessionSource(SOURCES(), 'nope')).toBeUndefined();
  });

  it('picks the most recently written transcript', () => {
    const old = session('old', ['{"a":1}']);
    const recent = session('recent', ['{"a":1}']);
    const t = Date.now() / 1000;
    utimesSync(old, t - 600, t - 600);
    utimesSync(recent, t, t);
    expect(findLatestSession(SOURCES())?.sessionId).toBe('recent');
  });

  it('ignores empty files when guessing', () => {
    const real = session('real', ['{"a":1}']);
    writeFileSync(join(sources, 'empty.jsonl'), '');
    const t = Date.now() / 1000;
    utimesSync(real, t - 60, t - 60);
    utimesSync(join(sources, 'empty.jsonl'), t, t);
    expect(findLatestSession(SOURCES())?.sessionId).toBe('real');
  });

  it('survives a missing source directory', () => {
    expect(findLatestSession([join(root, 'nope')])).toBeUndefined();
  });
});

describe('resolveCurrentSession — explicit beats ambient beats guessing', () => {
  it('prefers an explicit id', () => {
    session('aaa', ['{"a":1}']);
    session('bbb', ['{"a":1}']);
    const r = resolveCurrentSession(SOURCES(), { sessionId: 'aaa', env: {} });
    expect(r).toMatchObject({ sessionId: 'aaa', via: 'flag' });
  });

  it('uses the harness env var when there is no flag', () => {
    session('from-env', ['{"a":1}']);
    const r = resolveCurrentSession(SOURCES(), { env: { CLAUDE_SESSION_ID: 'from-env' } });
    expect(r).toMatchObject({ sessionId: 'from-env', via: 'env' });
  });

  it('prefers our own env var over the harness one', () => {
    session('ours', ['{"a":1}']);
    session('theirs', ['{"a":1}']);
    const r = resolveCurrentSession(SOURCES(), {
      env: { AGENTSENSEI_SESSION_ID: 'ours', CLAUDE_SESSION_ID: 'theirs' },
    });
    expect(r?.sessionId).toBe('ours');
  });

  it('falls through to a guess when the env id names nothing on disk', () => {
    // Inventing an id would be worse: the read would fail with a confusing error
    // rather than analysing the session that is actually there.
    session('real', ['{"a":1}']);
    const r = resolveCurrentSession(SOURCES(), { env: { CLAUDE_SESSION_ID: 'ghost' } });
    expect(r).toMatchObject({ sessionId: 'real', via: 'latest' });
  });

  it('reports the guess as a guess, so a wrong one is visible', () => {
    session('only', ['{"a":1}']);
    expect(resolveCurrentSession(SOURCES(), { env: {} })?.via).toBe('latest');
  });

  it('returns undefined when an explicit id does not exist', () => {
    session('aaa', ['{"a":1}']);
    expect(resolveCurrentSession(SOURCES(), { sessionId: 'nope', env: {} })).toBeUndefined();
  });
});
