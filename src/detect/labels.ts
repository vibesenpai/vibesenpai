/**
 * Harness reason strings, for naming a finding that already exists. The runner applies them after a
 * detector fires, so a reworded message loses only the label: CLAUDE.md "A detector reads structure".
 */

import type { Event } from '../types.ts';

/** What the harness said went wrong, as a stable key named for the developer's situation. */
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

/** Matched inside the envelope, anchored at the start so quoted file contents never match. */
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

/** The reason a failed call failed, or `undefined` (reason unknown) when unrecognised; never the nearest guess. */
export function reasonOf(e: Event): Reason | undefined {
  if (e.failureKind !== 'tool') return undefined;
  if (e.textSummary === undefined) return undefined;
  const inner = unwrap(e.textSummary);
  for (const r of REASONS) if (r.re.test(inner)) return r.reason;
  return undefined;
}

/** One line of advice per reason. */
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

/** Reason keys as plain English for the report. */
const REASON_LABELS: Record<string, string> = {
  'not-read-first': "the file wasn't read first",
  'string-not-found': "the text didn't match",
  'stale-read': 'the file changed after it was read',
  'ambiguous-target': 'the text matched several places',
  'no-op': 'the edit changed nothing',
  'missing-file': "the file doesn't exist",
  'bad-arguments': 'the call was malformed',
};

/** A reason key in plain words, for a reader. */
export function reasonLabel(key: string): string {
  return REASON_LABELS[key] ?? key.replace(/-/g, ' ');
}
