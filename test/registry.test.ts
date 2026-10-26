import { describe, expect, it } from 'vitest';
import {
  ParserRegistry, detectHarness, detectVersion, type TranscriptParser, parse, registry, claudeCode2_1,
} from '../src/parsers/index.ts';

const j = (o: unknown): string => JSON.stringify(o);

const stub = (over: Partial<TranscriptParser> = {}): TranscriptParser => ({
  id: 'test/1.x',
  harness: 'claude-code',
  testedVersions: { '1.0.0': 10 },
  versionRange: /^1\./,
  isFallback: false,
  parse: () => ({ events: [], unknown: {}, malformed: 0, skipped: {}, abandoned: 0 }),
  ...over,
});

describe('version detection', () => {
  it('scans past records that lack the field', () => {
    // `version` is on only some record types, so line 1 often lacks it.
    const lines = [
      j({ type: 'mode', mode: 'default' }),
      j({ type: 'last-prompt', leafUuid: 'x' }),
      j({ type: 'user', uuid: 'a', version: '2.1.296', message: { content: 'hi' } }),
    ];
    expect(detectVersion(lines)).toBe('2.1.296');
  });

  it('returns undefined when no record carries a version', () => {
    expect(detectVersion([j({ type: 'mode' }), j({ type: 'queue-operation' })])).toBeUndefined();
  });
});

describe('harness detection', () => {
  it('prefers the source path', () => {
    expect(detectHarness('/h/.claude/projects/p/s.jsonl', [])).toBe('claude-code');
    expect(detectHarness('/h/.codex/sessions/s.jsonl', [])).toBe('codex');
  });

  it('falls back to record shape when the path is uninformative', () => {
    const cc = [j({ type: 'user', uuid: 'a', parentUuid: null, isSidechain: false })];
    expect(detectHarness('/tmp/archived.jsonl', cc)).toBe('claude-code');
    expect(detectHarness('/tmp/x.jsonl', [j({ turn_type: 'user_prompt' })])).toBe('swe-chat');
    expect(detectHarness('/tmp/x.jsonl', [j({ nope: 1 })])).toBe('unknown');
  });
});

describe('factory selection', () => {
  it('matches a measured version exactly', () => {
    const r = new ParserRegistry().register(stub());
    expect(r.select('claude-code', '1.0.0')).toMatchObject({ match: 'exact' });
  });

  it('matches within a claimed range when the version is untested', () => {
    const r = new ParserRegistry().register(stub());
    expect(r.select('claude-code', '1.9.9')).toMatchObject({ match: 'range' });
  });

  it('falls back rather than refusing an out-of-range version', () => {
    // Refusing would lose data the archive exists to preserve.
    const r = new ParserRegistry().register(stub({ isFallback: true }));
    expect(r.select('claude-code', '99.0.0')).toMatchObject({ match: 'fallback' });
  });

  it('returns nothing for a harness with no parser', () => {
    const r = new ParserRegistry().register(stub());
    expect(r.select('codex', '1.0.0')).toBeUndefined();
  });

  it('rejects duplicate registrations', () => {
    const r = new ParserRegistry().register(stub());
    expect(() => r.register(stub())).toThrow(/already registered/);
  });

  it('prefers a range match over a fallback from another range', () => {
    const r = new ParserRegistry()
      .register(stub({ id: 'a/1.x', versionRange: /^1\./, testedVersions: {} }))
      .register(stub({ id: 'b/2.x', versionRange: /^2\./, testedVersions: {}, isFallback: true }));
    expect(r.select('claude-code', '1.5.0')).toMatchObject({ id: 'a/1.x' }.id ? { match: 'range' } : {});
    expect(r.select('claude-code', '1.5.0')?.parser.id).toBe('a/1.x');
  });
});

describe('provenance reporting', () => {
  const body = j({ type: 'user', uuid: 'a', version: '2.1.296', message: { content: 'hi' } });

  it('reports an exact match with no caveat', () => {
    const r = parse('/h/.claude/projects/p/s.jsonl', body);
    expect(r.provenance).toMatchObject({
      harness: 'claude-code',
      version: '2.1.296',
      strategy: 'claude-code/2.1.x',
      match: 'exact',
    });
    expect(r.provenance.caveat).toBeUndefined();
  });

  it('carries a caveat for an untested version inside the range', () => {
    const b = j({ type: 'user', uuid: 'a', version: '2.1.999', message: { content: 'hi' } });
    const r = parse('/h/.claude/projects/p/s.jsonl', b);
    expect(r.provenance.match).toBe('range');
    expect(r.provenance.caveat).toContain('2.1.999 is untested');
    expect(r.events).toHaveLength(1); // still parsed
  });

  it('carries a caveat for a version outside every range, and still parses', () => {
    const b = j({ type: 'user', uuid: 'a', version: '4.0.0', message: { content: 'hi' } });
    const r = parse('/h/.claude/projects/p/s.jsonl', b);
    expect(r.provenance.match).toBe('fallback');
    expect(r.provenance.caveat).toMatch(/outside every claimed range/);
    expect(r.events).toHaveLength(1);
  });

  it('carries a caveat when no version field exists at all', () => {
    const b = j({
      type: 'user', uuid: 'a', parentUuid: null, isSidechain: false,
      message: { content: 'hi' },
    });
    const r = parse('/h/.claude/projects/p/s.jsonl', b);
    expect(r.provenance.version).toBeUndefined();
    expect(r.provenance.caveat).toMatch(/no version field/);
  });

  it('parses a file from OUR OWN archive, where the path carries no hint', () => {
    // With no path hint, detection has only record shape; strictness would refuse valid files.
    const b = j({ type: 'user', uuid: 'a', parentUuid: null, version: '2.1.296', message: { content: 'hi' } });
    const r = parse('/home/u/.local/share/agentsensei/sessions/abc.jsonl', b);
    expect(r.provenance.harness).toBe('claude-code');
    expect(r.provenance.match).toBe('exact');
    expect(r.events).toHaveLength(1);
  });

  it('refuses a harness it has no parser for, rather than mangling it', () => {
    const r = parse('/h/.codex/sessions/s.jsonl', j({ foo: 1 }));
    expect(r.provenance).toMatchObject({ harness: 'codex', match: 'none', strategy: 'none' });
    expect(r.events).toEqual([]);
    expect(r.unknown['unsupported-harness:codex']).toBe(1);
  });

  it('exposes every measured version as evidence', () => {
    expect(registry.tested('claude-code')).toEqual(claudeCode2_1.testedVersions);
  });
});
