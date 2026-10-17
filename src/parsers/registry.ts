/**
 * Parser factory.
 *
 * A transcript's shape is not a constant. Four Claude Code versions already
 * appear in one developer's archive (2.1.201, 2.1.241, 2.1.296, 2.1.299), and
 * the public corpora we evaluate against were collected months earlier still. A
 * parser written against one version and applied to all of them degrades
 * silently — the failure mode this project exists to avoid.
 *
 * So parsers register themselves with the harness and version range they claim,
 * and the factory selects one. Adding a Codex parser, or a `claude-code/3.x`
 * strategy, is a registration — not an edit to every call site.
 *
 * Crucially, selection is **honest rather than strict**: an unrecognised version
 * still gets parsed by the nearest strategy, because refusing would lose data
 * that the archive exists to preserve. What changes is the reported support
 * level, the same way `unknown` is preferred over a guess everywhere else.
 */

import type { Event } from '../types.ts';

export type Harness = 'claude-code' | 'codex' | 'swe-chat' | 'unknown';

export type ParseOutput = {
  events: Event[];
  /** Unknown record or block types, counted. Never fatal. */
  unknown: Record<string, number>;
  malformed: number;
  skipped: Record<string, number>;
  /** Events on a branch the user abandoned — rewound, or resubmitted. */
  abandoned: number;
};

/**
 * How well the selected parser matches the input.
 *
 * - `exact`    — this version's records were measured directly.
 * - `range`    — inside a claimed range whose neighbours were measured. Drift
 *                within a patch series has not been observed, nor disproven.
 * - `fallback` — no range matched; the harness's last-resort parser ran.
 * - `none`     — nothing claims this harness.
 */
export type MatchLevel = 'exact' | 'range' | 'fallback' | 'none';

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
      // An unidentifiable file still gets a chance: parse it with a fallback
      // strategy and say so. Refusing would discard data the archive exists to
      // preserve, and `unknown` usually means detection was starved of signal
      // rather than that the file is foreign.
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

// ── detection ────────────────────────────────────────────────────────────────

/**
 * `version` is present on only 4 of 13 record types — `user`, `assistant`,
 * `system`, `attachment` carry it; the sidecar types (`mode`, `queue-operation`,
 * `file-history-*`, `ai-title`, `agent-name`, `atis-latch`) never do. So it is
 * derived per session by scanning until one appears, not read off line 1.
 */
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

/**
 * Source path first — the directory layout is the strongest signal — then record
 * shape, since the archive may hold files whose origin is no longer on disk.
 */
export function detectHarness(sourcePath: string, lines: readonly string[]): Harness {
  if (sourcePath.includes('.claude/projects')) return 'claude-code';
  if (sourcePath.includes('.codex/sessions')) return 'codex';

  for (const line of lines.slice(0, 50)) {
    const t = line.trim();
    if (t === '') continue;
    try {
      const r = JSON.parse(t) as Record<string, unknown>;
      if ('turn_type' in r) return 'swe-chat'; // SWE-chat's normalised column
      // `parentUuid` is the distinctive Claude Code field. Deliberately not
      // requiring `isSidechain` as well: our own archive stores files as
      // `sessions/<id>.jsonl`, so the path carries no harness hint and shape
      // detection is the only signal. Being strict here would make the archiver
      // produce files its own parser refuses.
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
