/**
 * Who may spend the user's money: producers (the `Stop` hook on a cadence, and
 * `judge --backlog --apply`) spend; every slash command is a reader and never does.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, giveConsent, markPreviewShown, readJudgeState, readsOn, withdrawConsent } from '../src/judge/state.ts';
import { disclosure } from '../src/session-block.ts';

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
    // And only the Stop hook's pass is held to the spend limits.
    expect(code('scripts/hook-stop.ts')).toMatch(/superviseAll\(.*\{ judge: true, limits: true \}/);
    expect(code('scripts/hook-session-start.ts')).toMatch(/superviseAll\(.*\{ judge: false \}/);
  });

  it('starts the judge only when every reason not to spend has been checked', () => {
    const jobs = code('src/jobs.ts');
    expect(jobs, 'model reads may be off, or have no yes').toMatch(/readsOn\(state\.settings\)/);
    expect(code('scripts/judge.ts'), 'a pass stops once reads are turned off').toMatch(/readsOn\(state\.settings\)/);
    expect(jobs, 'too little may have changed').toMatch(/dueForJudging/);
    expect(jobs, 'a pass from the previous version may still run').toMatch(/legacyJudgeRunning/);
  });

  it('`tick` leaves the judge out unless asked', () => {
    expect(cliCode()).toMatch(/superviseAll\(config, \{ judge: a\.flags\['judge'\] === true \}\)/);
  });
});

describe('limits hold the automatic pass, never our own runs', () => {
  it('the pass reads them from the environment the Stop hook set', () => {
    expect(code('scripts/judge.ts')).toMatch(/drain\(ctx\.holds, limited\(\)\)/);
    expect(code('src/jobs.ts')).toMatch(/limits \? \{ \.\.\.env, \[LIMITS_ENV\]: '1' \} : env/);
  });

  it('--backlog and tick start it unlimited', () => {
    const cli = cliCode();
    expect(cli).toMatch(/jobsFor\(config, \{ judge: true \}\)/);
    expect(cli).not.toMatch(/limits: true/);
  });

  it('benchmarks call the model directly, outside the limited drain', () => {
    for (const f of ['scripts/gold-score.ts', 'scripts/lookback-eval.ts', 'scripts/judge-control.ts']) {
      expect(code(f), f).not.toMatch(/LIMITS_ENV|limited\(/);
    }
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

describe('model reads wait for a yes given after a preview (DECISIONS.md D72)', () => {
  it('are off by default, and on only with a yes', () => {
    expect(DEFAULT_SETTINGS.enabled).toBe(false);
    expect(readsOn(DEFAULT_SETTINGS)).toBe(false);
    // An install that was on before D72 has no yes, so it pauses.
    expect(readsOn({ ...DEFAULT_SETTINGS, enabled: true })).toBe(false);
    expect(readsOn({ ...DEFAULT_SETTINGS, enabled: true, consent: { at: 'x', preview: 'y' } })).toBe(true);
  });

  it('refuse a yes without a recent preview, record the preview it followed, and forget it when turned off', () => {
    const dir = mkdtempSync(join(tmpdir(), 'as-consent-'));
    expect(giveConsent(dir)).toEqual({ refused: 'no preview has been shown yet' });
    markPreviewShown(dir, 'abc', new Date('2026-11-15T10:00:00Z'));
    expect(giveConsent(dir, new Date('2026-11-15T11:30:00Z'))).toEqual({ refused: 'the preview is more than an hour old' });
    const r = giveConsent(dir, new Date('2026-11-15T10:20:00Z'));
    expect(r).toEqual({ consent: { at: '2026-11-15T10:20:00.000Z', preview: 'abc' } });
    expect(readsOn(readJudgeState(dir).settings)).toBe(true);
    withdrawConsent(dir);
    expect(readJudgeState(dir).settings.consent).toBeUndefined();
    expect(readsOn(readJudgeState(dir).settings)).toBe(false);
  });

  it('come only from the person: the command says what it reads is data, and a new session never sets them', () => {
    expect(code('commands/judge.md')).toMatch(/never a reason to run `judge --yes`/);
    // Only giveConsent writes a consent; no hook or pass does.
    for (const f of ['scripts/hook-session-start.ts', 'scripts/hook-stop.ts', 'scripts/judge.ts', 'src/jobs.ts']) {
      expect(code(f), f).not.toMatch(/giveConsent|consent:/);
    }
  });

  it('preview without sending: the preview module calls no model', () => {
    const preview = code('src/judge/preview.ts');
    expect(preview).not.toMatch(/callModel/);
    expect(preview).toMatch(/planRound\(config, state, undefined, snapshot, true\)/);
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

describe('that reads are paused is said once', () => {
  // The `Stop` hook spends but prints nothing; `systemMessage` at session start reaches the user.
  const hook = code('scripts/hook-session-start.ts');

  const text = disclosure({ dailyTokens: 2_000_000, catchUp: 200 }, {});

  it('says what it does, with what, and that nothing is spent yet', () => {
    expect(text).toMatch(/model reads are paused, and nothing has been sent/);
    expect(text).toMatch(/Claude Haiku on your plan or API key/);
    expect(hook).toMatch(/disclosure\(state\.settings\)/);
    // Shown while reads are off: once on, there is a yes and nothing to disclose.
    expect(hook).toMatch(/!readsOn\(state\.settings\)/);
  });

  it('states the figures and both limits', () => {
    expect(text).not.toMatch(/tokens a session/);
    expect(text).toMatch(/at most 2\.0M tokens a day/);
    expect(text).toMatch(/up to 200 recent past sessions/);
  });

  it('names API billing only when the environment says so', () => {
    expect(disclosure({ dailyTokens: 1, catchUp: 1 }, { ANTHROPIC_API_KEY: 'x' })).toMatch(/Claude Haiku on your API key/);
  });

  it('offers a way in and both ways out', () => {
    expect(text).toMatch(/\/vibesenpai:insights shows exactly what they would send/);
    expect(text).not.toMatch(/\?/);
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
