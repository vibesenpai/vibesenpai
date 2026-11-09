/** `judge`: status, backlog, and the on/off switch for the model pass. */

import { readFileSync } from 'node:fs';
import { bold, dim } from '../style.ts';
import { basename, join } from 'node:path';
import { discoverTranscripts, sessionSizes } from '../read.ts';
import { readJudgeState, writeSettings } from '../judge/state.ts';
import { pendingWork } from '../judge/schedule.ts';
import { clean, jobsFor } from '../jobs.ts';
import { releaseHold, supervise, type JobSpec } from '../supervise/index.ts';
import type { Config } from '../config.ts';
import { renderExtract } from '../judge/prompt.ts';
import { buildSession, estimateTokens, JUDGE_OVERHEAD_TOKENS } from '../judge/packet.ts';
import { parseTranscript, withFullText } from '../parsers/claude-code.ts';
import { dollars, duration, human, plural } from '../format.ts';
import { resetCatchUp, todayLeft, waitingOnRequest } from '../judge/limits.ts';
import { readSpend, withStore } from '../store.ts';
import { type Argv, configFromFlags } from './common.ts';

/** Start the judge now through the supervisor, as the Stop hook would. False if a pass already holds it. */
function startJudge(config: Config): boolean {
  const judge = jobsFor(config, { judge: true }).find((j) => j.name === 'judge') as JobSpec;
  const decided = supervise([{ ...judge, isDue: () => true }], { archive: config.archive, clean });
  return decided['judge'] === 'start';
}

export function cmdJudge(a: Argv): number {
  const { config } = configFromFlags(a);
  const state = readJudgeState(config.archive);
  const f = a.flags;

  // `--status`: the judge is the only slow, detached step, so the only one with a progress view.
  if (f['status'] === true) {
    const { judged, pending, unread, behind } = pendingWork(state, sessionSizes(config.sources));

    console.log(`judge · ${state.settings.enabled ? 'enabled' : 'disabled'} · model ${state.settings.model}`);
    console.log('');

    // An unreadable store has no count; printing `judged 0` would be a false report.
    if (state.storeUnreadable === true) {
      console.log(`  judged     ${bold('unknown')} — the store could not be read`);
      console.log(`  ${dim(`it is at ${join(config.archive, 'store.db')}`)}`);
      console.log(`  ${dim('delete it to start a fresh one; findings are re-derived from transcripts')}`);
    } else {
      // "read" includes sessions with new turns since; `judged` alone counts only fully caught-up ones.
      console.log(
        `  read       ${judged + behind} session(s) · ${state.findings.length} finding(s)`,
      );
    }
    if (pending === 0) {
      console.log('  pending    nothing — every session is up to date');
      console.log('');
      console.log(`  ${dim('`no findings` from `now` or `report` means a clean bill of health,')}`);
      console.log(`  ${dim('not an unfinished pass.')}`);
    } else {
      // Counts, not a time estimate: completion is paced by turns ending, not by model time.
      const parts: string[] = [];
      if (unread > 0) parts.push(`${unread} never read`);
      if (behind > 0) parts.push(`${behind} with new turns since`);
      console.log(`  pending    ${parts.join(' · ')}`);
      console.log('');
      // The `Stop` hook triggers the pass.
      console.log(
        `  ${dim(
          state.settings.enabled
            ? 'read in the background from when a turn ends, within the daily limit.'
            : 'disabled — nothing will be read or sent.',
        )}`,
      );
    }
    const { dailyTokens } = state.settings;
    const left = todayLeft(config.archive, dailyTokens);
    console.log('');
    if (left !== undefined) {
      console.log(`  today      ${human(Math.max(dailyTokens - left, 0))} of ${human(dailyTokens)} tokens${left <= 0 ? ' · budget reached, continues tomorrow' : ''}`);
    }
    const waiting = waitingOnRequest(config.archive, state, sessionSizes(config.sources));
    if (waiting > 0) console.log(`  older      ${plural(waiting, 'session')} not read`);
    if (state.usage.calls > 0) {
      const spend = withStore(config.archive, readSpend);
      const usd = spend?.usdMicros === undefined ? '' : ` · ${dollars(spend.usdMicros)}`;
      console.log(
        `  spent      ${state.usage.calls} call(s) · ${human(state.usage.inputTokens)} in · ` +
          `${human(state.usage.outputTokens)} out${usd}`,
      );
      if (usd !== '') console.log(`  ${dim("dollars are Claude Code's own figure at API prices; on a subscription it is plan usage, not a bill.")}`);
    }
    return 0;
  }

  // `--backlog`: a large spend, so it prints an estimate and waits for `--apply`.
  if (f['backlog'] === true) {
    const { pending, seconds } = pendingWork(state, sessionSizes(config.sources));
    if (pending === 0) {
      console.log('nothing pending — every session is up to date');
      return 0;
    }
    if (!state.settings.enabled) {
      console.log('the judge is disabled; nothing would run');
      return 1;
    }
    if (f['apply'] !== true) {
      console.log(`this would read ${plural(pending, 'session')} with the model on your account`);
      console.log(
        `  about ${duration(seconds)} · roughly ${(pending * 58).toLocaleString()}k input tokens`,
      );
      console.log('');
      console.log('  nothing has been sent. re-run with --apply to start it.');
      return 0;
    }
    if (!startJudge(config)) {
      console.log('a pass is already running, or retrying after a failure — nothing started.');
      return 0;
    }
    console.log(`reading ${plural(pending, 'session')} — about ${duration(seconds)}.`);
    console.log(dim('  it runs in the background; findings appear as they land.'));
    return 0;
  }

  if (f['disable'] === true) {
    if (f['apply'] !== true) {
      console.log('would disable the judge. re-run with --apply.');
      return 0;
    }
    writeSettings(config.archive, { ...state.settings, enabled: false });
    console.log('judge disabled. nothing further will be sent.');
    return 0;
  }

  // The automatic pass's limits (src/judge/limits.ts). Explicit runs, like --backlog, ignore them.
  for (const [flag, key, what] of [
    ['daily-tokens', 'dailyTokens', 'tokens a day'],
    ['catch-up', 'catchUp', 'past sessions to catch up on'],
  ] as const) {
    const v = f[flag];
    if (v === undefined) continue;
    const n = typeof v === 'string' ? Number(v) : NaN;
    if (!Number.isInteger(n) || n < 0) {
      console.log(`--${flag} takes a whole number`);
      return 1;
    }
    if (f['apply'] !== true) {
      console.log(`would set ${what} to ${n.toLocaleString()}. re-run with --apply.`);
      return 0;
    }
    writeSettings(config.archive, { ...state.settings, [key]: n });
    // A new catch-up size is measured afresh from today's unread sessions.
    if (key === 'catchUp') resetCatchUp(config.archive);
    console.log(`${what}: ${n.toLocaleString()}.`);
    return 0;
  }

  // Priced from a real packet, not an average.
  const sessions = [];
  for (const source of discoverTranscripts(config.sources).slice(0, 5)) {
    const id = basename(source, '.jsonl');
    try {
      const r = withFullText(() => parseTranscript(readFileSync(source, 'utf8').split('\n'), id));
      const ev = [...r.result.events].sort((x, y) => x.seq - y.seq);
      if (ev.length === 0) continue;
      const p = buildSession(id, ev, r.fullText);
      if (p.packet.turns.length > 0) sessions.push(p);
    } catch {
      // Unreadable here is not an error; the runner counts those.
    }
  }

  const packetTokens = sessions.length === 0 ? 0 : estimateTokens(renderExtract(sessions));

  console.log(`judge · ${state.settings.enabled ? 'enabled' : 'disabled'} · model ${state.settings.model}`);
  console.log('');
  console.log('  what one pass would send');
  console.log(`    stage 1  ${sessions.length} session(s) · ~${packetTokens.toLocaleString()} tokens of transcript`);
  // Stage 2 reads stage 1's records, so its packet is small, but it pays the overhead again.
  console.log('    stage 2  the episodes stage 1 found · a few hundred tokens each');
  // The overhead is Claude Code's own system prompt and tools; not ours to shrink.
  console.log(`    ${JUDGE_OVERHEAD_TOKENS.toLocaleString()} tokens of invocation overhead per stage, whatever we send`);
  console.log('    output is roughly 98% thinking — measured, not estimated');
  console.log('');
  console.log(`  cadence  every ~${state.settings.cadence} turns of new transcript`);
  console.log(`  ceiling  ${state.settings.maxBatchTokens.toLocaleString()} tokens per batch`);
  if (state.usage.calls > 0) {
    console.log('');
    console.log(
      `  spent so far  ${state.usage.calls} call(s) · ` +
        `${state.usage.inputTokens.toLocaleString()} in · ` +
        `${state.usage.outputTokens.toLocaleString()} out`,
    );
  }
  console.log(`  limits   ${human(state.settings.dailyTokens)} tokens a day · catch-up on ${state.settings.catchUp} past sessions`);

  if (f['dry-run'] === true) {
    console.log('\n  --dry-run: nothing was sent.');
    return 0;
  }
  if (f['enable'] !== true) {
    console.log('\n  --enable to turn it on, --dry-run to see a packet, --disable to stop.');
    return 0;
  }
  if (f['apply'] !== true) {
    console.log('\n  nothing written. re-run with --enable --apply to turn it on.');
    return 0;
  }

  writeSettings(config.archive, { ...state.settings, enabled: true });
  // Enabling is also the explicit act that releases a hold after repeated paid failures.
  releaseHold(config.archive, 'judge');
  console.log('\n  judge enabled. it runs detached, after your turn ends.');
  console.log('  /vibesenpai:judge off stops it.');
  return 0;
}
