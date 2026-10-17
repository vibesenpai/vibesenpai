/**
 * Public parser surface. Register strategies here; callers use `parse()`.
 */

import { parseTranscript } from './claude-code.ts';
import {
  ParserRegistry,
  parseWith,
  type ParseResult,
  type TranscriptParser,
} from './registry.ts';

export {
  ParserRegistry,
  detectHarness,
  detectVersion,
  type Harness,
  type MatchLevel,
  type ParseResult,
  type Provenance,
  type TranscriptParser,
} from './registry.ts';

/**
 * Claude Code 2.1.x.
 *
 * `testedVersions` is evidence, not intent: these are the versions whose records
 * have actually been read, with counts measured 2026-10-15. Extend it only after
 * measuring — a version listed here claims to be verified.
 */
export const claudeCode2_1: TranscriptParser = {
  id: 'claude-code/2.1.x',
  harness: 'claude-code',
  testedVersions: { '2.1.201': 9, '2.1.241': 2225, '2.1.296': 757, '2.1.299': 71 },
  versionRange: /^2\.1\./,
  // The only Claude Code strategy, so it also absorbs unknown versions rather
  // than letting a transcript go unparsed.
  isFallback: true,
  parse: (lines, sessionId) => parseTranscript(lines, sessionId),
};

export const registry = new ParserRegistry().register(claudeCode2_1);

/** Parse a transcript, selecting a strategy by harness and version. */
export function parse(sourcePath: string, text: string, sessionId = ''): ParseResult {
  return parseWith(registry, sourcePath, text, sessionId);
}
