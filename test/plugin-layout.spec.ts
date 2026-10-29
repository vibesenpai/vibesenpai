/** The plugin layout. Each assertion pins something `claude plugin validate` or `details` rejected. */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const json = (p: string): Record<string, unknown> =>
  JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;

describe('the marketplace manifest matches the schema', () => {
  const m = json('.claude-plugin/marketplace.json');

  it('has an owner, which is required and was missing', () => {
    expect(m['owner']).toBeTypeOf('object');
    expect((m['owner'] as { name?: string }).name).toBeTruthy();
  });

  it('points at the plugin with a source the validator accepts', () => {
    // `{ source: 'local', path: '.' }` is rejected; a relative string is accepted.
    const p = (m['plugins'] as { source?: unknown }[])[0];
    expect(typeof p?.source, 'source must be a relative path string').toBe('string');
    expect(p?.source as string).toMatch(/^\.\//);
  });

  it('carries no fields Claude Code ignores', () => {
    expect(m['interface']).toBeUndefined();
    expect((m['plugins'] as Record<string, unknown>[])[0]?.['policy']).toBeUndefined();
  });
});

describe('components are where Claude Code looks for them', () => {
  it('puts hooks at hooks/hooks.json', () => {
    // At `.claude-plugin/hooks.json` the inventory reports Hooks (0).
    expect(existsSync('hooks/hooks.json'), 'hooks must be at hooks/hooks.json').toBe(true);
    expect(existsSync('.claude-plugin/hooks.json'), 'the old location must be gone').toBe(false);
  });

  it('gives every hook an explicit timeout', () => {
    // Required by CLAUDE.md Principle Zero.
    const h = json('hooks/hooks.json')['hooks'] as Record<string, { hooks: { timeout?: number }[] }[]>;
    const events = Object.keys(h);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      for (const matcher of h[event] as { hooks: { timeout?: number }[] }[]) {
        for (const hook of matcher.hooks) {
          expect(hook.timeout, `${event} hook has no timeout`).toBeTypeOf('number');
        }
      }
    }
  });

  it('keeps commands flat, because the plugin name is the namespace', () => {
    // A subdirectory reports Skills (0) and would double the namespace.
    const entries = readdirSync('commands', { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    expect(dirs, 'commands/ must contain no subdirectories').toEqual([]);
    expect(entries.filter((e) => e.name.endsWith('.md')).length).toBeGreaterThan(0);
  });
});
