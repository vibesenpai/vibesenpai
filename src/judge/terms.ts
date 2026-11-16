/**
 * The terms a person agrees to when turning model reads on, said the same way everywhere they are asked.
 * Cost figures are Claude Code's own `total_cost_usd` from the store, measured on the author's sessions
 * on 2026-11-15 (385 calls, about 12.9M tokens, $1.13); re-measured each release. Never a price table.
 */

/** How long a yes lasts. */
export const READS_LAST =
  'Turning them on keeps them running on Claude Haiku, in your own Claude Code account, after each turn ends, until you turn them off with /vibesenpai:judge off.';

/** What they cost, from measurement, and what that means on a subscription. */
export const READS_COST =
  'They are cheap: usually a few cents a session at most, at API prices. A day is capped at 2M tokens, about $0.26 at most, and the first catch-up of up to 200 past sessions is about $2, spread over several days by that cap. On a Claude subscription it counts toward your plan\'s usage instead of a bill.';

/** What redaction removes and what it leaves, in one line. */
export const READS_REDACTION =
  'Removed before sending: keys, tokens, passwords, email addresses and your home folder. Left in: ordinary code and command output.';

export const READS_WHERE = 'Sent to: claude -p on your account, model Haiku, with no tools.';

/** The same terms, short, for the pane's preview rows. */
export const READS_SHORT = {
  to: 'Claude Haiku, on your own Claude Code account, no tools',
  costs: 'a few cents a session, $0.26 a day at most',
  costsNote: 'The first catch-up of past sessions is about $2, over a few days. On a Claude subscription, it is plan usage, not a bill.',
  redaction: 'Keys, tokens, passwords, email addresses and your home folder are removed before sending.',
  lasts: 'Once on, they keep running until /vibesenpai:judge off.',
};
