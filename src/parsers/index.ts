/**
 * Parsers, and the factory that picks one per transcript by harness and version.
 * An unrecognised version is still parsed by the nearest strategy; the provenance says how well it matched.
 */

import { parseTranscript, type ParseOutput } from './claude-code.ts';

export type Harness = 'claude-code' | 'codex' | 'swe-chat' | 'unknown';

/** How well the selected parser matches the input: `range` means untested inside a claimed range. */
type MatchLevel = 'exact' | 'range' | 'fallback' | 'none';

export type Provenance = {
  harness: Harness;
  version: string | undefined;
  /** Which strategy ran, e.g. `claude-code/2.1.x`. */
  strategy: string;
  match: MatchLevel;
  /** Present whenever `match` is not `exact`. Surfaced to the user, not swallowed. */
  caveat?: string;
};

export type ParseResult = ParseOutput & { provenance: Provenance };

export interface TranscriptParser {
  /** Stable id, `<harness>/<range>`. Appears in output and in the verdict cache key. */
  readonly id: string;
  readonly harness: Harness;
  /** Versions measured against real records, with counts as the evidence. */
  readonly testedVersions: Readonly<Record<string, number>>;
  /** The version range claimed, e.g. `/^2\.1\./`. */
  readonly versionRange: RegExp;
  /** Serve this harness when no range matches, and when no version is present. */
  readonly isFallback: boolean;
  parse(lines: string[], sessionId: string): ParseOutput;
}

export class ParserRegistry {
  private readonly parsers: TranscriptParser[] = [];

  register(p: TranscriptParser): this {
    if (this.parsers.some((x) => x.id === p.id)) {
      throw new Error(`parser already registered: ${p.id}`);
    }
    this.parsers.push(p);
    return this;
  }

  list(): readonly TranscriptParser[] {
    return this.parsers;
  }

  /** Every version any registered parser has actually been measured against. */
  tested(harness?: Harness): Record<string, number> {
    const out: Record<string, number> = {};
    for (const p of this.parsers) {
      if (harness !== undefined && p.harness !== harness) continue;
      for (const [v, n] of Object.entries(p.testedVersions)) out[v] = (out[v] ?? 0) + n;
    }
    return out;
  }

  select(
    harness: Harness,
    version: string | undefined,
  ): { parser: TranscriptParser; match: MatchLevel } | undefined {
    const forHarness = this.parsers.filter((p) => p.harness === harness);
    if (forHarness.length === 0) {
      // An unidentified file is parsed by a fallback and says so, rather than refused.
      if (harness === 'unknown') {
        const any = this.parsers.find((p) => p.isFallback);
        if (any) return { parser: any, match: 'fallback' };
      }
      return undefined;
    }

    if (version !== undefined) {
      const exact = forHarness.find((p) => version in p.testedVersions);
      if (exact) return { parser: exact, match: 'exact' };

      const inRange = forHarness.find((p) => p.versionRange.test(version));
      if (inRange) return { parser: inRange, match: 'range' };
    }

    const fallback = forHarness.find((p) => p.isFallback) ?? forHarness[0];
    return fallback ? { parser: fallback, match: 'fallback' } : undefined;
  }
}

// Detection

/** `version` is on only some record types, so scan until one carries it rather than reading line 1. */
export function detectVersion(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const t = line.trim();
    if (t === '' || !t.includes('"version"')) continue;
    try {
      const v = (JSON.parse(t) as { version?: unknown }).version;
      if (typeof v === 'string' && v !== '') return v;
    } catch {
      /* keep scanning */
    }
  }
  return undefined;
}

/** Codex record types, from a public corpus. */
const CODEX_TYPES = new Set(['session_meta', 'response_item', 'event_msg', 'turn_context']);

/** Source path first, then record shape. */
export function detectHarness(sourcePath: string, lines: readonly string[]): Harness {
  if (sourcePath.includes('.claude/projects')) return 'claude-code';
  if (sourcePath.includes('.codex/sessions') || sourcePath.includes('/codex/')) return 'codex';

  for (const line of lines.slice(0, 50)) {
    const t = line.trim();
    if (t === '') continue;
    try {
      const r = JSON.parse(t) as Record<string, unknown>;
      if ('turn_type' in r) return 'swe-chat'; // SWE-chat's normalised column

      // Checked before Claude Code: Codex rollouts appear outside `.codex/` directories.
      const ty = r['type'];
      if (typeof ty === 'string' && CODEX_TYPES.has(ty)) return 'codex';

      // `parentUuid` alone marks Claude Code; requiring more would refuse valid files.
      if ('parentUuid' in r) return 'claude-code';
    } catch {
      /* skip */
    }
  }
  return 'unknown';
}

function caveatFor(
  match: MatchLevel,
  harness: Harness,
  version: string | undefined,
  parser: TranscriptParser | undefined,
): string | undefined {
  switch (match) {
    case 'exact':
      return undefined;
    case 'range':
      return (
        `${harness} ${version ?? '?'} is untested; parsed by ${parser?.id} ` +
        `(measured: ${Object.keys(parser?.testedVersions ?? {}).join(', ')})`
      );
    case 'fallback':
      if (harness === 'unknown') {
        return `harness not identified — parsed by ${parser?.id}, findings may be incomplete`;
      }
      return version === undefined
        ? `no version field — parsed by ${parser?.id}, findings may be incomplete`
        : `${harness} ${version} is outside every claimed range — parsed by ${parser?.id}, findings may be incomplete`;
    case 'none':
      return `no parser registered for ${harness}`;
  }
}

/** The factory entry point: pick a parser, run it, report how much to trust it. */
export function parseWith(
  registry: ParserRegistry,
  sourcePath: string,
  text: string,
  sessionId = '',
): ParseResult {
  const lines = text.split('\n');
  const harness = detectHarness(sourcePath, lines);
  const version = detectVersion(lines);
  const selected = registry.select(harness, version);

  if (!selected) {
    return {
      events: [],
      unknown: { [`unsupported-harness:${harness}`]: 1 },
      malformed: 0,
      skipped: {},
      abandoned: 0,
      provenance: {
        harness,
        version,
        strategy: 'none',
        match: 'none',
        caveat: caveatFor('none', harness, version, undefined) as string,
      },
    };
  }

  const { parser, match } = selected;
  const out = parser.parse(lines, sessionId);
  const caveat = caveatFor(match, harness, version, parser);

  return {
    ...out,
    provenance: {
      harness,
      version,
      strategy: parser.id,
      match,
      ...(caveat !== undefined ? { caveat } : {}),
    },
  };
}

/** Claude Code 2.1.x. `testedVersions` lists only versions actually measured (2026-10-15). */
export const claudeCode2_1: TranscriptParser = {
  id: 'claude-code/2.1.x',
  harness: 'claude-code',
  testedVersions: { '2.1.201': 9, '2.1.241': 2225, '2.1.296': 757, '2.1.299': 71 },
  versionRange: /^2\.1\./,
  // The only Claude Code strategy, so it also parses unknown versions.
  isFallback: true,
  parse: (lines, sessionId) => parseTranscript(lines, sessionId),
};

export const registry = new ParserRegistry().register(claudeCode2_1);

/** Parse a transcript, selecting a strategy by harness and version. */
export function parse(sourcePath: string, text: string, sessionId = ''): ParseResult {
  return parseWith(registry, sourcePath, text, sessionId);
}
