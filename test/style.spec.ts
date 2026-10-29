/** `pad` must measure visible width: escape sequences have length but no width. Tests run both modes. */

import { describe, expect, it } from 'vitest';
import { pad } from '../src/style.ts';

/** Strip escapes, leaving what a terminal would actually show. */
const visible = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '');

describe('pad', () => {
  const loud = (s: string): string => `\u001b[1m${s}\u001b[0m`;

  it('measures the plain text, not the escape sequences', () => {
    const styled = pad('142', 8, loud, 'right');
    // 13 characters of string, 8 columns of width.
    expect(styled.length).toBeGreaterThan(8);
    expect(visible(styled)).toBe('     142');
  });

  it('aligns a styled and an unstyled cell to the same column', () => {
    // The real bug: one row bold, the next not, and the columns diverge.
    expect(visible(pad('142', 6, loud, 'right'))).toBe(visible(pad('142', 6, undefined, 'right')));
    expect(visible(pad('1127', 6, loud, 'right'))).toHaveLength(6);
  });

  it('pads left by default and right on request', () => {
    expect(visible(pad('ab', 5))).toBe('ab   ');
    expect(visible(pad('ab', 5, undefined, 'right'))).toBe('   ab');
  });

  it('never truncates — a value wider than its column keeps all of itself', () => {
    // Losing a digit misreports a figure; a ragged column is better.
    expect(visible(pad('123456', 3))).toBe('123456');
  });
});
