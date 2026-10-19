/**
 * The `Stop` hook. Drains, advances, and may spawn — never analyses.
 *
 * ```
 * 1. kill switch, on line one
 * 2. advance the boundary clock; drop what decayed
 * 3. mark what the statusline will show, so the rate limit can see it
 * 4. spawn DETACHED analysis and exit immediately
 * ```
 *
 * ── It prints nothing, and that is the point ────────────────────────────────
 *
 * Hook stdout is **not** user-visible: it is injected into the model's context.
 * Surfacing here would feed a finding into the agent mid-session and change the
 * behaviour of the session being measured — an observer effect that corrupts the
 * evidence and makes "we measured your habits" false. The statusline renders;
 * this only updates state.
 *
 * ── Principle Zero, in order ───────────────────────────────────────────────
 *
 * `AGENTSENSEI_DISABLE=1` short-circuits before any logic. Analysis is detached
 * and unwaited, so a hung analyser cannot hold a session open. The circuit
 * breaker stops spawning after repeated failures. Exits 0 unconditionally.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readQueue, writeQueue, advance, pick, markShown } from '../src/queue.ts';
import { isTripped, readBreaker } from '../src/breaker.ts';
import { resolveConfig } from '../src/config.ts';

/** The payload Claude Code sends a hook on stdin. */
type StopPayload = { session_id?: string; transcript_path?: string };

function readStdin(): StopPayload {
  try {
    return JSON.parse(readFileSync(0, 'utf8')) as StopPayload;
  } catch {
    return {};
  }
}

function main(): void {
  if (process.env['AGENTSENSEI_DISABLE'] === '1') return;

  const payload = readStdin();
  const { config } = resolveConfig();

  // Advance the clock and record what the statusline is about to show. Done
  // here rather than in the statusline because this is a single serialised
  // moment, while a statusline runs often and on its own schedule.
  let q = advance(readQueue(config.archive));
  const showing = pick(q);
  if (showing !== undefined) q = markShown(q, showing);
  writeQueue(config.archive, q);

  if (isTripped(readBreaker(config.archive))) return;

  const transcript = payload.transcript_path;
  const sessionId = payload.session_id;
  if (transcript === undefined || sessionId === undefined) return;

  // Detached and unwaited. The hook cannot hold the session open, and killing
  // the session cannot corrupt a half-written queue — the write is
  // temp-then-rename.
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', join(import.meta.dirname, 'analyse.ts'), transcript, sessionId],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
}

try {
  main();
} catch {
  // Silence. A hook that reports its own failure into the model's context would
  // be surfacing through the channel this design rejects.
}
process.exit(0);
