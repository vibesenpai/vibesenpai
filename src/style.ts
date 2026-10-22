/**
 * Terminal styling, and the rule that keeps it from leaking.
 *
 * ── Why this is gated rather than always on ────────────────────────────────
 *
 * There are two paths out of this tool and they need different things:
 *
 *   `node src/cli.ts now`   a real terminal. ANSI renders.
 *   `/agentsensei:now`      the command body says "show the output exactly as
 *                           it is", so the text reaches the reader *through
 *                           the model*. Escape codes would arrive as literal
 *                           `^[[1m` and the reproduction would be garbage.
 *
 * So colour follows `isTTY`: present when something is watching, absent the
 * moment output is piped. `NO_COLOR` turns it off (the de-facto standard) and
 * `AGENTSENSEI_COLOR=1|0` forces it either way, which is what makes the
 * difference testable rather than something to reason about.
 *
 * ── Width is computed on the raw string, always ────────────────────────────
 *
 * An escape sequence has length and no width. `'\u001b[1m142\u001b[0m'.length`
 * is 13 where the column it occupies is 3, so padding a styled string destroys
 * every column in the report — and only in colour mode, which is the mode the
 * tests do not run in. `pad()` exists so that cannot happen: it measures the
 * plain text and styles afterwards.
 */

/** Set once at import: a flag read per-call would make output depend on order. */
const ON = ((): boolean => {
  const force = process.env['AGENTSENSEI_COLOR'];
  if (force === '1') return true;
  if (force === '0') return false;
  if (process.env['NO_COLOR'] !== undefined) return false;
  return process.stdout.isTTY === true;
})();

const wrap = (open: string) => (s: string): string => (ON ? `\u001b[${open}m${s}\u001b[0m` : s);

/** The figure itself — the thing a reader should see first. */
export const bold = wrap('1');
/** Chrome: rules, units, labels that are context rather than content. */
export const dim = wrap('2');
/** A refusal. Used on the marker, never on a whole line. */
export const red = wrap('31');
/** A count or quantity. */
export const cyan = wrap('36');
/** A subject — the file or command a finding is about. */
export const yellow = wrap('33');
/** Confidence, and anything else that is metadata about the finding. */
export const green = wrap('32');

/**
 * Pad to a column width using the **plain** text's length, then style.
 *
 * `pad('142', 6, bold)` is six columns wide whether or not colour is on. The
 * alternative — `bold('142').padStart(6)` — is six columns in plain mode and
 * sixteen in colour mode.
 */
export function pad(
  raw: string,
  width: number,
  style: (s: string) => string = (s) => s,
  align: 'left' | 'right' = 'left',
): string {
  const fill = ' '.repeat(Math.max(0, width - raw.length));
  return align === 'right' ? `${fill}${style(raw)}` : `${style(raw)}${fill}`;
}

/** A horizontal rule, dimmed so it separates without competing. */
export function rule(width: number): string {
  return dim('─'.repeat(Math.max(0, width)));
}
