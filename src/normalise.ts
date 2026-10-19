/**
 * Volatility normalisation for tool output.
 *
 * Shared by the parser (which hashes output) and by any detector that compares
 * it. One implementation, because the two must agree: if the parser normalised
 * differently from the comparator, every hash comparison would be meaningless
 * in a way nothing would reveal.
 *
 * ── What must survive ───────────────────────────────────────────────────────
 *
 * Only things that change for reasons unrelated to the code are removed:
 * durations, timestamps, hashes, addresses, and line/column references. **Counts
 * are preserved**, because an earlier version replaced every digit and collapsed
 *
 *     Tests: 3 failed, 9 passed
 *     Tests: 2 failed, 10 passed
 *     Tests: 1 failed, 11 passed
 *
 * into one identical string — reporting steady progress as a loop. The spec is
 * explicit that an error signature is the normalised first error line *plus the
 * failure count*: the count is signal.
 */

import { createHash } from 'node:crypto';

export function normaliseOutput(text: string | undefined): string {
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
 * Digest of a tool result's **full** output, after volatility normalisation.
 *
 * This exists because `textSummary` is capped at 200 characters, and measured
 * over 3,748 real results **59.9% hit that cap**. Comparing summaries therefore
 * compared *prefixes*: two different failures sharing an opening line looked
 * identical, which is a false-positive path straight into a `certain` detector.
 *
 * A digest rather than the text itself: it answers "same output?", which is all
 * a detector needs, while storing nothing. Computed over the redacted form, so
 * it cannot serve as an oracle for a secret that appeared in output.
 */
export function outputDigest(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const norm = normaliseOutput(text);
  if (norm === '') return undefined; // empty output tells a detector nothing
  return createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

/**
 * Is this string a timestamp a session could actually have?
 *
 * One definition, used at both boundaries that take timestamps from untrusted
 * text: the catalog, which reads the top-level `timestamp` of raw JSONL, and the
 * parser, which puts it on an `Event`. They must agree — a value the catalog
 * rejects but the parser keeps would make a session's span disagree with its own
 * events.
 *
 * A regex over raw text was tried first and is unsafe: `"timestamp"` appears
 * inside tool results that echoed a CI payload, a lockfile or a server log, and
 * one pasted line carrying `"timestamp": "2019-03-04…"` would set a session's
 * start to 2019 — making `report` claim full depth across years holding nothing.
 * Measured on the public corpus, 9 of 219 files already had a wider span that
 * way; none catastrophically, which is exactly why it would have shipped.
 *
 * So this is the second line of defence: a value outside a sane window cannot be
 * a session time, whatever a future record type puts in the field.
 */
export function isPlausibleTimestamp(v: unknown): v is string {
  if (typeof v !== 'string' || v === '') return false;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return false;
  const floor = Date.UTC(2023, 0, 1); // predates any Claude Code transcript
  return t >= floor && t <= Date.now() + 86_400_000;
}
