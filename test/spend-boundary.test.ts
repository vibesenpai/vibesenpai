/**
 * Who may spend the user's money, and who may not.
 *
 * ── Why this boundary moved, and why it moved back ─────────────────────────
 *
 * The judge used to fire from the `Stop` hook on a cadence. That was replaced
 * by firing from `/agentsensei:session`, on the reasoning that asking about a
 * session is a fair moment to read it — and it was wrong for a reason the
 * pipeline model made obvious: it put a producer inside a reader. The command
 * said "now", looked like a view, and charged ~58k tokens for it.
 *
 * So producers produce and readers read:
 *
 *   PRODUCERS   the `Stop` hook, on a cadence
 *               `judge --backlog --apply`, explicitly and after showing cost
 *   READERS     every slash command. None of them spends.
 *
 * `Stop` fires when the main agent has finished responding, which is exactly
 * when a turn's work exists to analyse. The consent for it is the install plus
 * the one-time disclosure, not a per-turn decision nobody is present to make.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearJudgeRunning,
  DEFAULT_SETTINGS,
  JUDGE_RUNNING_STALE_MS,
  judgeRunning,
  markJudgeRunning,
} from '../src/judge-store.ts';

/**
 * Source with comments stripped.
 *
 * An earlier version of this guard failed on the comment in `hook-stop.ts`
 * explaining why a spawn had been removed — prose worth keeping. A guard about
 * behaviour should read code.
 */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('the Stop hook is the producer', () => {
  const hook = code('scripts/hook-stop.ts');

  it('spawns a pass for the live session', () => {
    expect(hook).toMatch(/spawnDetached\(\s*['"]judge\.ts['"]/);
  });

  it('gates every reason not to spend', () => {
    // Each of these is a reason the user would not want to be charged, and
    // each is cheap enough to check in a hook that has milliseconds.
    expect(hook, 'the judge may be disabled').toMatch(/settings\.enabled/);
    expect(hook, 'a pass may already be running').toMatch(/judgeRunning/);
    expect(hook, 'the breaker may be tripped').toMatch(/isTripped/);
    expect(hook, 'too little may have changed').toMatch(/dueForJudging/);
  });

  it('still refreshes the standing, which is local and free', () => {
    expect(hook).toMatch(/spawnDetached\(\s*['"]compute-standing/);
  });
});

describe('no command spends', () => {
  const cli = code('src/cli.ts');

  it('`session` renders what exists and starts nothing', () => {
    // The whole reason this surface is worth typing is that it is instant —
    // measured at 0.41s. A command that waits on a model is a different
    // product, and a command that spawns one silently is a worse one.
    const cmd = /async function cmdSession[\s\S]*?\n}/.exec(cli)?.[0] ?? '';
    expect(cmd, 'cmdSession not found').not.toBe('');
    expect(cmd).not.toMatch(/spawnJudge|spawnDetached|markJudgeRunning/);
  });

  it('neither does `fix` or `report`', () => {
    for (const name of ['cmdFix', 'cmdReport']) {
      const cmd = new RegExp(`(async )?function ${name}[\\s\\S]*?\\n}`).exec(cli)?.[0] ?? '';
      expect(cmd, `${name} not found`).not.toBe('');
      expect(cmd, `${name} spends`).not.toMatch(/spawnJudge|spawnDetached|markJudgeRunning/);
    }
  });

  it('makes the backlog the one explicit exception', () => {
    // Not a reader, and it does not pretend to be: it prints what a full pass
    // would cost and sends nothing until told twice, the same `--apply` shape
    // as `install`.
    const backlog = /f\['backlog'\][\s\S]{0,1600}?return 0;\n  }/.exec(cli)?.[0] ?? '';
    expect(backlog, 'the --backlog branch moved or vanished').not.toBe('');
    expect(backlog).toMatch(/f\['apply'\] !== true/);
    expect(backlog).toMatch(/nothing has been sent/);
  });
});

describe('the judge ships on', () => {
  it('is enabled by default', () => {
    // Defensible only because of the boundary above: the entry point is
    // `/plugin install`, and the structural tier alone is one detector that
    // found 4 occurrences across 18 real sessions where the judge found 19.
    expect(DEFAULT_SETTINGS.enabled).toBe(true);
  });

  it('discloses the first spend once, through a channel the user can see', () => {
    // The producer is a hook now, and hooks print nothing — Principle One. So
    // the notice surfaces through the session-start block, which is the one
    // channel that reaches a user rather than the model.
    const store = code('src/judge-store.ts');
    expect(store).toMatch(/export function hasDisclosed/);
    expect(store).toMatch(/export function markDisclosed/);
  });
});

describe('a pass cannot overlap itself', () => {
  // Found by reading `pgrep` output during a timing test: two invocations had
  // produced two independent passes on the same session, each ~58k tokens, on
  // the same bytes. The ledger does not advance until stage A returns, so both
  // saw the same offset and both decided the session was due.
  const dir = () => mkdtempSync(join(tmpdir(), 'as-lock-'));

  it('reports a fresh marker as running', () => {
    const d = dir();
    expect(judgeRunning(d)).toBe(false);
    markJudgeRunning(d);
    expect(judgeRunning(d)).toBe(true);
  });

  it('ages a stale marker out, so a crashed pass does not block for ever', () => {
    const d = dir();
    markJudgeRunning(d);
    expect(judgeRunning(d, Date.now() + JUDGE_RUNNING_STALE_MS + 1)).toBe(false);
  });

  it('clears on release', () => {
    const d = dir();
    markJudgeRunning(d);
    clearJudgeRunning(d);
    expect(judgeRunning(d)).toBe(false);
  });

  it('is taken before every spawn, and released however the pass exits', () => {
    expect(code('scripts/hook-stop.ts')).toMatch(/markJudgeRunning/);
    expect(code('src/cli.ts'), 'the backlog path takes it too').toMatch(/markJudgeRunning/);

    // `finally`, not a success path — a crash must still release it.
    const pass = code('scripts/judge.ts');
    expect(pass).toMatch(/\.finally\(/);
    expect(pass).toMatch(/clearJudgeRunning/);
  });
});
