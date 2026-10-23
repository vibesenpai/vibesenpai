/**
 * The plugin layout, which is now the only way anyone installs this.
 *
 * Every assertion here corresponds to something `claude plugin validate` or
 * `claude plugin details` actually rejected. None of it was guesswork, and
 * none of it was caught by reading the docs — the layout looked right and was
 * wrong in three places:
 *
 *   marketplace.json  2 schema errors; `/plugin marketplace add` would fail
 *   hooks location    `.claude-plugin/hooks.json` → "Hooks (0)"
 *   command nesting   `commands/agentsensei/now.md` → "Skills (0)",
 *                     and would have namespaced to /agentsensei:agentsensei:now
 */
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
    // `{ source: 'local', path: '.' }` was rejected. The official catalog uses
    // a plain relative string for a plugin inside the same repository.
    const p = (m['plugins'] as { source?: unknown }[])[0];
    expect(typeof p?.source, 'source must be a relative path string').toBe('string');
    expect(p?.source as string).toMatch(/^\.\//);
  });

  it('carries no fields Claude Code ignores', () => {
    // `interface` and `policy` were copied from another marketplace's cached
    // form and are silently dropped at load.
    expect(m['interface']).toBeUndefined();
    expect((m['plugins'] as Record<string, unknown>[])[0]?.['policy']).toBeUndefined();
  });
});

describe('components are where Claude Code looks for them', () => {
  it('puts hooks at hooks/hooks.json', () => {
    // At `.claude-plugin/hooks.json` the inventory reported **Hooks (0)** —
    // the plugin would have installed and done nothing in the background.
    expect(existsSync('hooks/hooks.json'), 'hooks must be at hooks/hooks.json').toBe(true);
    expect(existsSync('.claude-plugin/hooks.json'), 'the old location must be gone').toBe(false);
  });

  it('gives every hook an explicit timeout', () => {
    // Required by CLAUDE.md, and `install.ts` writes 5. The plugin's copy had
    // none and relied on `|| true` alone.
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
    // `commands/agentsensei/now.md` reported **Skills (0)** and would have
    // namespaced to `/agentsensei:agentsensei:now` if it had loaded at all.
    const entries = readdirSync('commands', { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    expect(dirs, 'commands/ must contain no subdirectories').toEqual([]);
    expect(entries.filter((e) => e.name.endsWith('.md')).length).toBeGreaterThan(0);
  });

  it('ships the hooks in the package too', () => {
    // `files` listed `.claude-plugin` but not `hooks`, so moving the file
    // would have dropped it from the tarball.
    expect(json('package.json')['files'] as string[]).toContain('hooks');
  });
});
