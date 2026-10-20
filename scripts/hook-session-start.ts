/**
 * The `SessionStart` hook. **Spawns and exits. Prints nothing.**
 *
 * ── Why it prints nothing ──────────────────────────────────────────────────
 *
 * A hook's stdout goes into the *agent's* context, not the user's terminal. The
 * original design accepted that for a session-start report, on the grounds that
 * statistics do not contaminate the way instructions do — and that is a fair
 * argument. This is stricter: it puts **nothing** in the model's context, so the
 * tool cannot perturb the session it measures, not even by ~100 tokens, and a
 * finding can never read as if Claude said it.
 *
 * The cost of that strictness is one round trip. The standing is not ready at
 * session start, so it surfaces at the first `Stop` boundary instead — which is
 * seconds later and is where the statusline updates anyway.
 *
 * ── Fire and forget ────────────────────────────────────────────────────────
 *
 * Parsing all history takes ~500ms for four transcripts and scales from there,
 * so it cannot happen here. The child is detached with its output discarded and
 * `unref`'d, so this process exits immediately and the session never waits.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { isTripped, readBreaker } from '../src/breaker.ts';
import { resolveConfig } from '../src/config.ts';
import { isFresh, markStarted, readStanding } from '../src/standing.ts';

function main(): void {
  if (process.env['AGENTSENSEI_DISABLE'] === '1') return;

  const { config } = resolveConfig();
  if (isTripped(readBreaker(config.archive))) return;

  // Nothing to do if the standing is recent: four windows in a minute must not
  // parse the whole history four times.
  if (isFresh(readStanding(config.archive))) return;

  // Marked before spawning, so the first boundary after an install has
  // something friendly to show rather than an empty bar.
  markStarted(config.archive);

  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', join(import.meta.dirname, 'compute-standing.ts')],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
}

try {
  main();
} catch {
  // Silence. Reporting a failure here would mean printing into the model's
  // context, which is the one thing this hook exists to avoid.
}
process.exit(0);
