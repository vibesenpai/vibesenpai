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

import { readQueue, pick, lineFor } from '../src/queue.ts';
import { resolveConfig } from '../src/config.ts';

function main(): void {
  if (process.env['AGENTSENSEI_DISABLE'] === '1') return;

  const { config } = resolveConfig();
  const q = readQueue(config.archive);
  const entry = pick(q);
  const line = lineFor(entry, q.entries.length);
  if (line !== '') process.stdout.write(line);
}

try {
  main();
} catch {
  // Silence is the correct failure mode for an ambient surface.
}
// Unconditionally successful, whatever happened above.
process.exit(0);
