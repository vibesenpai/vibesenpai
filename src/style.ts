/**
 * Terminal styling. Colour follows `isTTY` (output relayed through the model must carry no escapes);
 * `NO_COLOR` disables it, `AGENTSENSEI_COLOR=1|0` forces it. Widths are measured on the plain text.
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

/** Pad using the plain text's length, then style, so columns line up with colour on or off. */
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
