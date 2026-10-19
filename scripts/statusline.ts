/**
 * The statusline renderer. **Reads only.**
 *
 * ── Contract, verified rather than assumed ─────────────────────────────────
 *
 * Claude Code hands a statusline command a **JSON payload on stdin** and uses
 * its **stdout as the line**. Confirmed from the harness's own changelog —
 * "added `added_dirs` to the statusline JSON `workspace` section, exposing
 * directories added via `/add-dir` to external scripts" and "fixed multi-line
 * statusline output dropping or corrupting rows when any line exceeds terminal
 * width". This matters because *hook* stdout behaves differently: it goes to the
 * model's context, not the screen. The two channels are not interchangeable and
 * the design rests on the difference.
 *
 * ── Why this is the surfacing channel ──────────────────────────────────────
 *
 * Hook stdout reaches the model, so surfacing through it would feed "you are
 * looping" into the agent's context and change the behaviour of the session we
 * are measuring. An analyzer must not be a participant. The statusline is a
 * passive render: it steals no focus, injects no text, blocks nothing, and waits
 * to be looked at.
 *
 * ── Principle Zero ─────────────────────────────────────────────────────────
 *
 * Exits 0 unconditionally and prints nothing it is unsure of. A statusline that
 * throws puts a stack trace in someone's status bar; one that hangs stalls the
 * render. There is no analysis here and no write — just a file read.
 */

import { readFileSync } from 'node:fs';
import { countFor, lineFor, pick, readQueue } from '../src/queue.ts';
import { resolveConfig } from '../src/config.ts';

/** The payload Claude Code sends a statusline command on stdin. */
type StatusPayload = { session_id?: string };

/**
 * Read the payload, or nothing.
 *
 * Nothing is a usable answer: an unscoped line is still better than a crash,
 * and `pick` treats a missing session id as "any session".
 */
function readPayload(): StatusPayload {
  try {
    return JSON.parse(readFileSync(0, 'utf8')) as StatusPayload;
  } catch {
    return {};
  }
}

function main(): void {
  if (process.env['AGENTSENSEI_DISABLE'] === '1') return;

  // Scoped to THIS session. Two windows on two projects share one archive, so
  // an unscoped line would point at turns that are not in the session being
  // looked at — a finding about somebody else's work.
  const sessionId = readPayload().session_id;

  const { config } = resolveConfig();
  const q = readQueue(config.archive);
  const line = lineFor(pick(q, sessionId), countFor(q, sessionId));
  if (line !== '') process.stdout.write(line);
}

try {
  main();
} catch {
  // Silence is the correct failure mode for an ambient surface.
}
// Unconditionally successful, whatever happened above.
process.exit(0);
