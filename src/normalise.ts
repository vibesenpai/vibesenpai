/**
 * Volatility normalisation for tool output, shared by the parser and any comparator so hashes agree.
 * Removes durations, timestamps, hashes, addresses and line:col refs. Counts are kept: they are signal.
 */

import { createHash } from 'node:crypto';

function normaliseOutput(text: string | undefined): string {
  return (text ?? '')
    .toLowerCase()
    // ISO timestamps
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z?/g, 'T')
    // durations — "1.2s", "450ms", "3 min"
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds|m|min|mins|h|hr)\b/g, 'D')
    // memory addresses, uuids, content hashes
    .replace(/0x[0-9a-f]+/g, 'H')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, 'H')
    .replace(/\b[0-9a-f]{7,}\b/g, 'H')
    // line:col references, so a shifted line is not a new failure
    .replace(/:\d+(?::\d+)?\b/g, ':L')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Digest of a tool result's full normalised output; `textSummary` is capped, so comparing it compares prefixes.
 * Computed over redacted text, so it cannot be an oracle for a secret.
 */
export function outputDigest(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const norm = normaliseOutput(text);
  if (norm === '') return undefined; // empty output tells a detector nothing
  return createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

/**
 * Is this a timestamp a session could have? Shared by the catalog and parser so spans agree; rejects
 * values like a 2019 date echoed in tool output.
 */
export function isPlausibleTimestamp(v: unknown): v is string {
  if (typeof v !== 'string' || v === '') return false;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return false;
  const floor = Date.UTC(2023, 0, 1); // predates any Claude Code transcript
  return t >= floor && t <= Date.now() + 86_400_000;
}

/**
 * The events whose `tokens` should be counted: one per API response (records repeat the same `usage`).
 * Hold the result by identity, never by uuid (uuids are not unique). Filter to usage-bearing events first.
 */
export function oncePerResponse<T extends { uuid: string; responseId?: string }>(
  events: readonly T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const e of events) {
    const key = e.responseId ?? e.uuid;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}
