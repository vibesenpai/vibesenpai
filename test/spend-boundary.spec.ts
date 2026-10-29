/**
 * Who may spend the user's money: producers (the `Stop` hook on a cadence, and
 * `judge --backlog --apply`) spend; every slash command is a reader and never does.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DEFAULT_SETTINGS } from '../src/judge/state.ts';

/** Source with comments stripped, so the guard reads code, not prose. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** The CLI and every command it dispatches. */
const cliCode = (): string =>
  ['src/cli.ts', ...readdirSync('src/cmd').map((f) => `src/cmd/${f}`)].map(code).join('\n');

describe('the Stop hook is the producer', () => {
  it('runs the supervisor with the judge included; session start never does', () => {
    expect(code('scripts/hook-stop.ts')).toMatch(/superviseAll\(.*\{ judge: true \}/);
    expect(code('scripts/hook-session-start.ts')).toMatch(/superviseAll\(.*\{ judge: false \}/);
  });

  it('starts the judge only when every reason not to spend has been checked', () => {
    const jobs = code('src/jobs.ts');
    expect(jobs, 'the judge may be disabled').toMatch(/settings\.enabled/);
    expect(jobs, 'too little may have changed').toMatch(/dueForJudging/);
    expect(jobs, 'a pass from the previous version may still run').toMatch(/legacyJudgeRunning/);
  });

  it('`tick` leaves the judge out unless asked', () => {
    expect(cliCode()).toMatch(/superviseAll\(config, \{ judge: a\.flags\['judge'\] === true \}\)/);
  });
});

describe('no command spends', () => {
  const cli = cliCode();

  it('`insights` renders what exists and starts nothing', () => {
    // Instant by design: a reader must never wait on or spawn a model.
    const cmd = /async function cmdInsights[\s\S]*?\n}/.exec(cli)?.[0] ?? '';
    expect(cmd, 'cmdInsights not found').not.toBe('');
    expect(cmd).not.toMatch(/startJudge|superviseAll|runDetached|supervise\(/);
  });

  it('neither does `fix` or `report`', () => {
    for (const name of ['cmdFix', 'cmdReport']) {
      const cmd = new RegExp(`(async )?function ${name}[\\s\\S]*?\\n}`).exec(cli)?.[0] ?? '';
      expect(cmd, `${name} not found`).not.toBe('');
      expect(cmd, `${name} spends`).not.toMatch(/startJudge|superviseAll|runDetached|supervise\(/);
    }
  });

  it('makes the backlog the one explicit exception', () => {
    // Prints the cost and sends nothing without `--apply`.
    const backlog = /f\['backlog'\][\s\S]{0,1600}?return 0;\n  }/.exec(cli)?.[0] ?? '';
    expect(backlog, 'the --backlog branch moved or vanished').not.toBe('');
    expect(backlog).toMatch(/f\['apply'\] !== true/);
    expect(backlog).toMatch(/nothing has been sent/);
  });
});

describe('the judge ships on', () => {
  it('is enabled by default', () => {
    expect(DEFAULT_SETTINGS.enabled).toBe(true);
  });

  it('discloses the first spend once, through a channel the user can see', () => {
    // Hooks print nothing, so the notice goes through the session-start block.
    const store = code('src/judge/state.ts');
    expect(store).toMatch(/export function hasDisclosed/);
    expect(store).toMatch(/export function markDisclosed/);
  });
});

describe('a pass cannot overlap itself', () => {
  // Two invocations once judged the same bytes twice. The lease is taken atomically before every start.
  it('is taken by the supervisor before any start, and the pass runs inside `runJob`', () => {
    expect(code('src/supervise/supervise.ts')).toMatch(/takeLease\(/);
    expect(code('scripts/judge.ts')).toMatch(/runJob\('judge'/);
    expect(cliCode(), 'the backlog path goes through the supervisor too').toMatch(/supervise\(\[/);
  });

  it('checks it still holds the lease before every send and every write', () => {
    const run = code('src/judge/run.ts');
    expect((run.match(/if \(!holds\(\)\) return fenced\(\);/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});

describe('the first spend is disclosed once', () => {
  // The `Stop` hook spends but prints nothing; `systemMessage` at session start reaches the user.
  const hook = code('scripts/hook-session-start.ts');

  it('says what it does before what it costs', () => {
    expect(hook).toMatch(/reads your finished sessions/);
    expect(hook).toMatch(/where effort went to waste/);
  });

  it('makes the cost checkable instead of asserting a figure', () => {
    // `/usage` attributes spend by plugin, so the user can check the real number.
    expect(hook).toMatch(/on your own plan/);
    expect(hook).toMatch(/\/usage/);
    expect(hook, 'no uncalibratable token figure').not.toMatch(/58k/);
  });

  it('offers a way in, not just a way out', () => {
    expect(hook).toMatch(/\/agentsensei:insights/);
    expect(hook).toMatch(/plugin disable agentsensei/);
  });

  it('goes out through systemMessage, not the model channel', () => {
    // `additionalContext` would put the tool inside the session it measures (DECISIONS.md D11/D58).
    expect(hook).toMatch(/systemMessage/);
    expect(hook).not.toMatch(/additionalContext/);
  });

  it('is gated on having not said it before, and records that it did', () => {
    expect(hook).toMatch(/!hasDisclosed\(config\.archive\)/);
    expect(hook).toMatch(/markDisclosed\(config\.archive\)/);
  });

  it('is one message, not two', () => {
    // Two `systemMessage` writes from one hook means one is discarded.
    expect(hook).toMatch(/\$\{notice\}\$\{block\}/);
  });
});
