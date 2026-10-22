/**
 * The one way this project calls a model.
 *
 * ── Why it is one function ─────────────────────────────────────────────────
 *
 * There were three near-copies: `scripts/judge.ts`, `scripts/gold-score.ts`
 * and `scripts/judge-control.ts`. All three shared the argv, the isolated
 * working directory, the `AGENTSENSEI_DISABLE` guard and the `is_error` check —
 * and diverged on the things that matter when something goes wrong: a 180s
 * timeout against 300s, a 32MB buffer against 64MB, and three different return
 * shapes. Copies drift silently, and these had already drifted.
 *
 * ── The three defences, which must travel together ────────────────────────
 *
 * A judge that judges its own output is a loop that bills, so none of these is
 * optional:
 *
 * 1. `AGENTSENSEI_DISABLE=1` in the child's environment — our own hooks
 *    short-circuit on line one.
 * 2. A dedicated working directory containing `JUDGE_CWD_MARKER`, which
 *    `discoverTranscripts` filters out. Measured before it existed: three probe
 *    calls took one machine from 9 discovered sessions to 12.
 * 3. `--allowed-tools ''` — the child reads nothing and writes nothing.
 *
 * `claude --bare` would skip hooks and plugin sync, which is what is wanted,
 * but its auth becomes strictly `ANTHROPIC_API_KEY` and returns `is_error` with
 * "Not logged in" on a subscription. So the child is a real session, and the
 * three defences above are why that is safe.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JUDGE_CWD_MARKER } from './read.ts';
import { redact } from './redact.ts';

export type ModelReply = {
  reply: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * What the harness itself says the call cost.
   *
   * Reported rather than derived, and **never shown to a user**: on a
   * subscription it is notional, and "no prices users cannot know" is a
   * standing decision here. It exists so a measurement script can state what
   * an experiment consumed.
   */
  usd: number;
};

/** Where the child runs. The marker is what keeps its transcript out of ours. */
export function modelCwd(): string {
  const dir = join(tmpdir(), JUDGE_CWD_MARKER);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Would redaction still change this? Then it does not leave the machine.
 *
 * **Asserted, not warned.** Measured: 50% of corpus sessions carry
 * secret-class content at packet fidelity — `secret-assignment`, `api-key`,
 * `jwt`, `url-credentials`, `bearer` — and tool output is where they
 * concentrate. Every input is redacted already (the parser does it, `packet.ts`
 * does it as its last construction step); this catches the case neither can: a
 * future path that assembles a packet without going through the builder.
 *
 * `redact(x).text === x` and never `isIdempotent`: the latter returns true for
 * text redaction would still change, which is a distinction this project got
 * wrong once already.
 *
 * It lives beside `callModel` because the two belong together — the gate is
 * only meaningful immediately before the thing that sends. It was a private
 * helper in `scripts/judge.ts` and an inline comparison in
 * `scripts/gold-score.ts`, which is one copy too many for a check whose whole
 * job is that nothing slips past it.
 */
export function wouldLeak(packet: string): boolean {
  return redact(packet).text !== packet;
}

export type ModelOptions = {
  /** Default 300s. The long pole is the model, and a judge pass is detached. */
  timeoutMs?: number;
  /** Default 64MB. A refused-but-large reply must not throw on the buffer. */
  maxBufferBytes?: number;
};

/**
 * One call. `undefined` on any failure, because a broken analyzer must never
 * break a session — the caller records the failure and exits 0.
 *
 * `is_error` and never `subtype`: a not-logged-in reply sets `is_error: true`
 * while `subtype` still reads "success".
 */
export function callModel(
  packet: string,
  model: string,
  opts: ModelOptions = {},
): ModelReply | undefined {
  try {
    const out = execFileSync(
      'claude',
      ['-p', packet, '--output-format', 'json', '--allowed-tools', '', '--model', model],
      {
        cwd: modelCwd(),
        encoding: 'utf8',
        timeout: opts.timeoutMs ?? 300_000,
        maxBuffer: opts.maxBufferBytes ?? 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, AGENTSENSEI_DISABLE: '1' },
      },
    );
    const parsed = JSON.parse(out) as {
      is_error?: boolean;
      result?: string;
      usage?: Record<string, number>;
      total_cost_usd?: number;
    };
    if (parsed.is_error === true || typeof parsed.result !== 'string') return undefined;
    const u = parsed.usage ?? {};
    return {
      reply: parsed.result,
      inputTokens:
        (u['cache_creation_input_tokens'] ?? 0) +
        (u['cache_read_input_tokens'] ?? 0) +
        (u['input_tokens'] ?? 0),
      outputTokens: u['output_tokens'] ?? 0,
      usd: parsed.total_cost_usd ?? 0,
    };
  } catch {
    return undefined;
  }
}
