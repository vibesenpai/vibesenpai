import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Control characters in source fail the build: an invisible NUL in a doc comment once made a
 * later edit silently not apply.
 */
describe('source hygiene', () => {
  const files = execSync('find src test -name "*.ts"', { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('contains no invisible control characters', () => {
    // Tab, newline and carriage return are legitimate; nothing else is.
    const allowed = new Set([0x09, 0x0a, 0x0d]);
    const offenders: string[] = [];

    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        const isControl = code < 0x20 || code === 0x7f;
        if (!isControl || allowed.has(code)) continue;
        const line = text.slice(0, i).split('\n').length;
        offenders.push(`${f}:${line} U+${code.toString(16).padStart(4, '0')}`);
        break;
      }
    }

    expect(offenders, `control characters found:\n${offenders.join('\n')}`).toEqual([]);
  });
});
