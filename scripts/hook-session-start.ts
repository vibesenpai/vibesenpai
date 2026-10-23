/**
 * The `SessionStart` hook. Reports to the user, then spawns and exits.
 *
 * ── The channel, and why it reaches only the user ──────────────────────────
 *
 * `{"systemMessage": "..."}` on stdout renders in the **user's** main window.
 * Established from Anthropic's own plugins rather than from the docs, which get
 * it wrong: the `plugin-dev` skill calls `systemMessage` an "Explanation for
 * Claude", but `claude-security` prints an ASCII-art logo box through it, and
 * `security-guidance` names it in a comment as a *"user-visible TUI message"* —
 * explicitly distinct from `hookSpecificOutput.additionalContext`, which that
 * same comment describes as reaching "both the model and the user".
 *
 * **We emit `systemMessage` and never `additionalContext`.** Nothing reaches
 * the model, so the tool stays outside the session it measures. An earlier
 * version of this hook printed nothing at all, because the only channel then
 * known went through the model's context; that trade no longer exists.
 *
 * ── Fire and forget ────────────────────────────────────────────────────────
 *
 * The report is read from the last pass — this hook computes nothing. Parsing
 * all history takes ~500ms for four transcripts and scales from there, so the
 * refresh is detached, its output discarded, and `unref`'d. The session never
 * waits, and the pass that runs now covers the session that just ended.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isTripped, readBreaker } from '../src/breaker.ts';
import {
  hasDisclosed, markDisclosed, readJudgeState, tallyByDimension,
} from '../src/judge-store.ts';
import { resolveConfig } from '../src/config.ts';
import { isFresh, markStarted, readStanding } from '../src/standing.ts';
import { detailLine, reportBlock } from '../src/report-line.ts';

/**
 * Said once per machine, never again.
 *
 * Deliberately short and factual. It names what will happen, on whose
 * account, roughly what it costs, and how to stop — and nothing else. A notice
 * that argues for itself is a notice people learn to skip.
 */
const DISCLOSURE = [
  '',
  'agentsensei reads your sessions with the model on your own account —',
  'about 58k tokens a session, in the background, after a turn finishes.',
  'Nothing is sent anywhere else, and the text is redacted before it leaves.',
  'To stop it: /plugin disable agentsensei',
  '',
].join('\n');

function main(): void {
  if (process.env['AGENTSENSEI_DISABLE'] === '1') return;

  const { config } = resolveConfig();

  // Report first, from the last completed pass. Done before the breaker check
  // so a tripped analyser still shows what it managed to learn earlier —
  // degrading to stale is better than degrading to silent.
  // The hook knows where this checkout is, which is what lets the detail line
  // name a command that actually runs here.
  const state = readJudgeState(config.archive);
  const block = reportBlock(
    readStanding(config.archive),
    detailLine(join(import.meta.dirname, '..'), homedir()),
    tallyByDimension(state),
  );

  // ── The one-time disclosure, on the only channel that reaches a user ─────
  //
  // The judge ships on, so the first time it is about to spend, the user is
  // told once. It cannot be said by the producer: the `Stop` hook spends, and
  // hooks print nothing (Principle One). `systemMessage` at session start is
  // the one surface that renders in the user's own window, so the notice
  // belongs here — prepended to the report rather than sent on its own, so it
  // is one message and not two.
  const notice = state.settings.enabled && !hasDisclosed(config.archive) ? DISCLOSURE : '';
  if (notice !== '') markDisclosed(config.archive);

  const message = `${notice}${block}`;
  if (message !== '') process.stdout.write(JSON.stringify({ systemMessage: message }));

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
