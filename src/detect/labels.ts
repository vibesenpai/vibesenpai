/**
 * Harness reason strings, for **naming** a finding that already exists.
 *
 * ── The one place text is allowed, and the limits on it ─────────────────────
 *
 * A detector cannot read text at all — `StructuralEvent` omits the fields and
 * the compiler enforces it. This module is the deliberate exception, and it is
 * the *runner* that calls it, after a detector has produced a valid candidate
 * from structure alone.
 *
 * So the dependency runs one way only: a finding never needs a label to exist.
 * If Anthropic rewords a message tomorrow, `reasonOf` returns `undefined`, the
 * finding still fires, and the report says the reason is unknown. Losing a
 * label is a cosmetic regression; losing a detection would be a silent one.
 *
 * ── Why a closed list is legitimate here ───────────────────────────────────
 *
 * The space is closed and Anthropic owns it. Measured over 1,135 failed edit
 * calls across 1,139 real sessions, **ten** distinct reasons appear inside the
 * `<tool_use_error>` envelope and the top four cover 965 of 1,031 (94%). That
 * is the opposite of the open space a framework list would be — and unlike the
 * lists this project removed, nothing here *decides* anything.
 */

import type { Event } from '../types.ts';

/**
 * What the harness said went wrong, as a stable key.
 *
 * Named for the *developer's* situation rather than the harness's wording,
 * because the key is what advice hangs off: `stale-read` and `not-read-first`
 * both mean "the agent's view of the file was wrong", but only one of them is
 * the agent's own omission.
 */
export type Reason =
  /** The agent wrote before reading. Its own missed step — 560 of 1,031. */
  | 'not-read-first'
  /** `old_string` did not match: whitespace, or a view gone stale — 241. */
  | 'string-not-found'
  /** A linter or the person changed the file after the read — 104. */
  | 'stale-read'
  /** Several matches, `replace_all` false: the anchor was too short — 60. */
  | 'ambiguous-target'
  /** `old_string` and `new_string` were identical — 11. */
  | 'no-op'
  /** The path does not exist — 11. */
  | 'missing-file'
  /** The call's arguments were malformed — 10. */
  | 'bad-arguments';

/**
 * The closed set, matched against the text **inside** the harness's envelope.
 *
 * Anchored at the start of the message, because these are the harness's own
 * opening words and a match anywhere would also fire on a file's contents being
 * quoted back — which is how a detector once read a line-numbered `Read` of a
 * doc file as a permission denial.
 */
const REASONS: { re: RegExp; reason: Reason }[] = [
  { re: /^File has not been read yet/, reason: 'not-read-first' },
  { re: /^String to replace not found in file/, reason: 'string-not-found' },
  { re: /^File has been modified since read/, reason: 'stale-read' },
  { re: /^Found \d+ matches of the string to replace/, reason: 'ambiguous-target' },
  { re: /^No changes to make/, reason: 'no-op' },
  { re: /^File does not exist/, reason: 'missing-file' },
  { re: /^InputValidationError/, reason: 'bad-arguments' },
];

/** Strip the harness's envelope, leaving the message it framed. */
function unwrap(text: string): string {
  return text
    .trimStart()
    .replace(/^<tool_use_error>/, '')
    .replace(/<\/tool_use_error>$/, '')
    .trimStart();
}

/**
 * The reason a failed call failed, or `undefined` when we do not recognise it.
 *
 * `undefined` is a first-class answer, not a gap to paper over: CLAUDE.md is
 * explicit that `unknown` beats guessing, and a new harness message must read as
 * "reason unknown" rather than get folded into the nearest familiar one.
 */
export function reasonOf(e: Event): Reason | undefined {
  if (e.failureKind !== 'tool') return undefined;
  if (e.textSummary === undefined) return undefined;
  const inner = unwrap(e.textSummary);
  for (const r of REASONS) if (r.re.test(inner)) return r.reason;
  return undefined;
}

/** One line of advice per reason. The second of the two outputs CLAUDE.md allows. */
const ADVICE: Record<Reason, string> = {
  'not-read-first': 'read the file before editing it',
  'string-not-found': 'the quoted text did not match — re-read before editing',
  'stale-read': 'a linter or you changed the file after it was read',
  'ambiguous-target': 'the anchor matched several places — quote more context',
  'no-op': 'the replacement was identical to the original',
  'missing-file': 'the path does not exist',
  'bad-arguments': 'the call was malformed',
};

export function adviceFor(reason: Reason): string {
  return ADVICE[reason];
}
