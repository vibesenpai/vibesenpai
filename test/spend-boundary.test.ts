/**
 * Nothing spends the user's money unless the user asked.
 *
 * The judge is on from installation now, which is only defensible because the
 * trigger moved rather than the consent. It used to fire from the `Stop` hook
 * on a byte cadence — fine while a user had enabled it in an explicit act, and
 * indefensible once it ships on. A detached process spending someone's money
 * at every turn boundary is the Self-Initiated Overreach this tool exists to
 * detect, and shipping it would make the product the thing it criticises.
 *
 * So this file guards the boundary, not the default. If `hook-stop.ts` ever
 * learns to spawn the judge again, these fail.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_SETTINGS } from '../src/judge-store.ts';

/**
 * Source with comments removed.
 *
 * The first version of this guard failed on the comment in `hook-stop.ts`
 * explaining *why* `maybeJudge` was deleted — prose this project would rather
 * keep than lose to a regex. A guard about behaviour should read code.
 */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('the Stop hook cannot spend', () => {
  const hook = code('scripts/hook-stop.ts');

  it('never spawns the judge', () => {
    // Asserted on the source because the alternative — running the hook and
    // watching for a child — is a race, and a flaky test on this boundary is
    // worse than none.
    expect(hook).not.toMatch(/spawnDetached\(\s*['"]judge/);
    expect(hook).not.toMatch(/maybeJudge/);
  });

  it('does not even read the judge store', () => {
    // Stronger than the above and easier to keep true: a hook with no reason
    // to know the judge exists cannot grow one by accident.
    expect(hook).not.toMatch(/judge-store/);
    expect(hook).not.toMatch(/dueForJudging/);
  });

  it('still refreshes the standing, which is local and free', () => {
    // The hook must not become a no-op either — this is what lets the next
    // session open with a report instead of a spinner.
    expect(hook).toMatch(/spawnDetached\(\s*['"]compute-standing/);
  });
});

describe('the judge ships on, and the command is what triggers it', () => {
  const cli = code('src/cli.ts');

  it('is enabled by default', () => {
    expect(DEFAULT_SETTINGS.enabled).toBe(true);
  });

  it('judges one session from `now`, never the backlog', () => {
    // ~58k input tokens for one session against ~1.05M for the 18 on this
    // machine. The bounded call is the whole reason this is affordable.
    expect(cli).toMatch(/maybeJudgeThisSession\(config, current\.sessionId/);
  });

  it('makes the backlog an explicit, costed act', () => {
    // Same `--apply` shape as `install` and `judge --disable`: print what it
    // would cost, send nothing, wait to be told twice.
    const backlog = /f\['backlog'\][\s\S]{0,1400}?return 0;\n  }/.exec(cli)?.[0] ?? '';
    expect(backlog, 'the --backlog branch moved or vanished').not.toBe('');
    expect(backlog).toMatch(/f\['apply'\] !== true/);
    expect(backlog).toMatch(/nothing has been sent/);
  });

  it('discloses the spend once, and records that it did', () => {
    expect(cli).toMatch(/hasDisclosed\(config\.archive\)/);
    expect(cli).toMatch(/markDisclosed\(config\.archive\)/);
  });
});
