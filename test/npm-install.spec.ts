// The npx installer in npm/: what it runs, and when it asks. DECISIONS.md D74.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { atLeast, installArgs, main, needsShell, parseArgs, parseVersion } from '../npm/lib/cli.mjs';

type Deps = Parameters<typeof main>[1];

function fake(over: Partial<Deps> = {}) {
  const calls: { cmd: string; args: string[] }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: Deps = {
    run: async (cmd, args) => { calls.push({ cmd, args }); return 0; },
    capture: async () => '2.1.328 (Claude Code)',
    ask: async () => 'y',
    out: (l) => { out.push(l); },
    err: (l) => { err.push(l); },
    interactive: true,
    nodeVersion: 'v24.1.0',
    ...over,
  };
  return { deps, calls, out, err };
}

const INSTALL = ['plugin', 'install', 'vibesenpai', '--marketplace', 'vibesenpai/vibesenpai'];

describe('npx vibesenpai', () => {
  it('prints help and runs nothing with no command', async () => {
    const f = fake();
    expect(await main([], f.deps)).toBe(0);
    expect(f.out.join('\n')).toContain('npx vibesenpai install');
    expect(f.calls).toEqual([]);
  });

  it('runs Claude Code\'s installer after a yes', async () => {
    const f = fake();
    expect(await main(['install'], f.deps)).toBe(0);
    expect(f.calls).toEqual([{ cmd: 'claude', args: INSTALL }]);
    expect(f.out.join('\n')).toContain(`claude ${INSTALL.join(' ')}`);
  });

  it('installs nothing on any answer but yes', async () => {
    for (const answer of ['', 'n', 'no', 'maybe']) {
      const f = fake({ ask: async () => answer });
      expect(await main(['install'], f.deps)).toBe(1);
      expect(f.calls).toEqual([]);
    }
  });

  it('never runs without a terminal unless --yes', async () => {
    const asked: string[] = [];
    const f = fake({ interactive: false, ask: async (q) => { asked.push(q); return 'y'; } });
    expect(await main(['install'], f.deps)).toBe(1);
    expect(f.calls).toEqual([]);
    expect(asked).toEqual([]);

    const g = fake({ interactive: false });
    expect(await main(['install', '--yes'], g.deps)).toBe(0);
    expect(g.calls).toHaveLength(1);
  });

  it('passes --scope through', async () => {
    const f = fake();
    await main(['install', '--scope', 'project', '-y'], f.deps);
    expect(f.calls[0]?.args).toEqual([...INSTALL, '--scope', 'project']);
    expect(installArgs(null)).toEqual(INSTALL);
  });

  it('rejects an unknown scope, option or command without running anything', async () => {
    for (const argv of [['install', '--scope', 'global'], ['install', '--force'], ['uninstall'], ['install', 'extra']]) {
      const f = fake();
      expect(await main(argv, f.deps)).toBe(2);
      expect(f.calls).toEqual([]);
    }
    expect(parseArgs(['install', '--scope'])).toHaveProperty('error');
  });

  it('stops when claude is missing or too old', async () => {
    const missing = fake({ capture: async () => null });
    expect(await main(['install', '-y'], missing.deps)).toBe(1);
    expect(missing.err.join('\n')).toContain('not on your PATH');

    const old = fake({ capture: async () => '2.1.298 (Claude Code)' });
    expect(await main(['install', '-y'], old.deps)).toBe(1);
    expect(old.err.join('\n')).toContain('2.1.299 or later');
    expect([...missing.calls, ...old.calls]).toEqual([]);
  });

  it('stops on an old Node', async () => {
    const f = fake({ nodeVersion: 'v22.12.0' });
    expect(await main(['install', '-y'], f.deps)).toBe(1);
    expect(f.calls).toEqual([]);
  });

  it('passes on the installer\'s exit code', async () => {
    const f = fake({ run: async () => 3 });
    expect(await main(['install', '-y'], f.deps)).toBe(3);
  });

  it('compares versions', () => {
    expect(parseVersion('2.1.328 (Claude Code)')).toEqual([2, 1, 328]);
    expect(parseVersion('no version')).toBeNull();
    expect(atLeast([22, 13, 0], [22, 13, 0])).toBe(true);
    expect(atLeast([22, 12, 9], [22, 13, 0])).toBe(false);
    expect(atLeast([23, 0, 0], [22, 13, 0])).toBe(true);
  });

  it('starts claude through a shell only on Windows', () => {
    expect(needsShell('win32')).toBe(true);
    expect(needsShell('darwin')).toBe(false);
    expect(needsShell('linux')).toBe(false);
  });

  it('keeps the package version in step with the plugin, and ships no install script', () => {
    const pkg = JSON.parse(readFileSync('npm/package.json', 'utf8'));
    const root = JSON.parse(readFileSync('package.json', 'utf8'));
    const plugin = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8'));
    expect(pkg.version).toBe(root.version);
    expect(pkg.version).toBe(plugin.version);
    expect(pkg.scripts ?? {}).toEqual({});
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});
