/**
 * The one way this project calls a model: the local `claude -p` CLI, isolated so the judge never
 * judges itself. `AGENTSENSEI_DISABLE=1`, a `JUDGE_CWD_MARKER` working directory that
 * `discoverTranscripts` skips, and no tools. Rules: .claude/rules/judge.md.
 */

import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JUDGE_CWD_MARKER } from '../read.ts';
import { redact } from '../redact.ts';

type ModelReply = {
  reply: string;
  inputTokens: number;
  outputTokens: number;
  /** What the harness says the call cost. Never shown to a user (no prices); for measurement scripts only. */
  usd: number;
  /** How long the call took, from the harness's own envelope. */
  durationMs?: number;
};

/** Where the child runs. The marker is what keeps its transcript out of ours. */
function modelCwd(): string {
  const dir = join(tmpdir(), JUDGE_CWD_MARKER);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Would redaction still change this? Then it does not leave the machine. Checked before every send.
 * Strict `redact(x).text === x`, never `isIdempotent`, which passes text redaction would still change.
 */
export function wouldLeak(packet: string): boolean {
  return redact(packet).text !== packet;
}

type ModelOptions = {
  /** Default 300s. The long pole is the model, and a judge pass is detached. */
  timeoutMs?: number;
  /** Default 64MB. A refused-but-large reply must not throw on the buffer. */
  maxBufferBytes?: number;
};

/**
 * One call. `undefined` on any failure, so the caller records it and exits 0.
 * Checks `is_error`, never `subtype`: a not-logged-in reply still says "success".
 */
export function callModel(
  packet: string,
  model: string,
  opts: ModelOptions = {},
): ModelReply | undefined {
  try {
    return parseReply(execFileSync('claude', modelArgs(packet, model), { ...modelExecOptions(opts), encoding: 'utf8' }));
  } catch {
    return undefined;
  }
}

/** The same call without blocking, so a pass can run several at once. */
export function callModelAsync(
  packet: string,
  model: string,
  opts: ModelOptions = {},
): Promise<ModelReply | undefined> {
  return new Promise((resolve) => {
    try {
      const child = execFile('claude', modelArgs(packet, model), { ...modelExecOptions(opts), encoding: 'utf8' }, (err, out) => {
        if (err !== null) {
          resolve(undefined);
          return;
        }
        try {
          resolve(parseReply(out));
        } catch {
          resolve(undefined);
        }
      });
      // `execFile` ignores `stdio`, and the CLI reads a non-TTY stdin: close it or every call times out.
      child.stdin?.end();
    } catch {
      resolve(undefined);
    }
  });
}

function modelArgs(packet: string, model: string): string[] {
  return ['-p', packet, '--output-format', 'json', '--allowed-tools', '', '--model', model];
}

function modelExecOptions(opts: ModelOptions) {
  return {
    cwd: modelCwd(),
    timeout: opts.timeoutMs ?? 300_000,
    maxBuffer: opts.maxBufferBytes ?? 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, AGENTSENSEI_DISABLE: '1' },
  };
}

/** One parse for both calls, so the sync and async paths cannot drift. Throws on bad JSON. */
function parseReply(out: string): ModelReply | undefined {
  const parsed = JSON.parse(out) as {
    is_error?: boolean;
    result?: string;
    usage?: Record<string, number>;
    total_cost_usd?: number;
    duration_ms?: number;
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
    ...(typeof parsed.duration_ms === 'number' ? { durationMs: parsed.duration_ms } : {}),
  };
}
