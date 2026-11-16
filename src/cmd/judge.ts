/** `judge`: status, backlog, and the on/off switch for the model pass. */

import { bold, dim } from '../style.ts';
import { join } from 'node:path';
import { sessionSizes } from '../read.ts';
import { giveConsent, readJudgeState, readsOn, withdrawConsent, writeSettings } from '../judge/state.ts';
import { previewNextPacket } from '../judge/preview.ts';
import { READS_COST, READS_LAST, READS_REDACTION, READS_SHORT, READS_WHERE } from '../judge/terms.ts';
import { pendingWork } from '../judge/schedule.ts';
import { clean, jobsFor } from '../jobs.ts';
import { releaseHold, supervise, type JobSpec } from '../supervise/index.ts';
import type { Config } from '../config.ts';
import { dollars, duration, human, plural } from '../format.ts';
import { resetCatchUp, todayLeft, waitingOnRequest } from '../judge/limits.ts';
import { readGated, readSent, readSentOne, readSpend, withStore } from '../store.ts';
import { rebuildSent } from '../judge/sent.ts';
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

    console.log(`judge: model reads ${readsOn(state.settings) ? 'on' : 'off until you say yes'}, model ${state.settings.model}`);
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
          readsOn(state.settings)
            ? 'read in the background from when a turn ends, within the daily limit.'
            : 'off until you say yes: nothing will be read or sent. /vibesenpai:judge on shows what would be.',
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

  // `--gated`: records the lookback gate dropped, so a missed failure can be read. Sends nothing.
  if (f['gated'] === true) {
    const limit = Number(f['limit'] ?? 20);
    const rows = withStore(config.archive, (db) => readGated(db, Number.isFinite(limit) && limit > 0 ? limit : 20));
    if (rows === undefined) {
      console.log('the store could not be read');
      return 1;
    }
    if (rows.length === 0) {
      console.log('nothing gated yet');
      return 0;
    }
    for (const r of rows) {
      console.log(`${bold(r.dimension)} · ${r.at.slice(0, 16).replace('T', ' ')} · session ${r.sessionId.slice(0, 8)} · turns ${r.turns.join(', ')}`);
      if (r.name !== undefined) console.log(`  ${r.name}`);
      if (r.quote !== undefined) console.log(`  “${r.quote.length > 200 ? `${r.quote.slice(0, 200)}…` : r.quote}”`);
      console.log(`  ${dim(`dropped: ${r.reason}`)}`);
      if (r.claimed !== undefined) console.log(`  ${dim(`claimed source: ${r.claimed}`)}`);
      console.log('');
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
    if (!readsOn(state.settings)) {
      console.log('model reads are off until you say yes; nothing would run');
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
    withdrawConsent(config.archive);
    console.log('Model reads are off. Nothing further will be sent. Turning them on again shows a new preview.');
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

  // What was sent: the record of each call, and its text rebuilt from the transcript (DECISIONS.md D73).
  if (f['sent'] === true) {
    const limit = Number(f['limit'] ?? 20);
    const rows = withStore(config.archive, (db) => readSent(db, Number.isFinite(limit) && limit > 0 ? limit : 20)) ?? [];
    if (f['json'] === true) {
      process.stdout.write(`${JSON.stringify(rows.map(({ recipes, ...r }) => ({ ...r, sessions: Array.isArray(recipes) ? recipes.length : 0 })))}\n`);
      return 0;
    }
    if (rows.length === 0) {
      console.log('Nothing has been sent.');
      return 0;
    }
    for (const r of rows) {
      const sessions = Array.isArray(r.recipes) ? `${plural(r.recipes.length, 'session')}, ` : '';
      console.log(`${r.id}  ${r.at.slice(0, 16).replace('T', ' ')}  step ${r.stage === 'extract' ? 1 : 2}  ${sessions}${r.chars.toLocaleString()} characters, ${(r.tokensIn ?? 0).toLocaleString()} tokens in, ${r.model}`);
    }
    console.log(dim('\n  `judge --sent-view <id>` rebuilds a step 1 call from its transcript and checks it against what was sent.'));
    return 0;
  }
  if (typeof f['sent-view'] === 'string') {
    const row = withStore(config.archive, (db) => readSentOne(db, Number(f['sent-view'])));
    if (row === undefined) {
      console.log('No such call.');
      return 1;
    }
    const back = rebuildSent(row);
    if (f['json'] === true) {
      process.stdout.write(`${JSON.stringify({ row: { ...row, recipes: undefined }, back })}\n`);
      return 0;
    }
    if (!back.ok) {
      console.log(`Not shown: ${back.reason}.`);
      return 0;
    }
    console.log(back.matched ? 'Exactly what was sent (it hashes to the record of the call):' : `${back.note ?? 'This differs from what was sent.'}`);
    console.log('');
    console.log(back.text);
    return 0;
  }

  // What the next read would send, built by the pass's own code and sent nowhere (src/judge/preview.ts).
  if (f['preview'] === true && f['json'] === true) {
    process.stdout.write(`${JSON.stringify({ ...previewNextPacket(config), terms: READS_SHORT })}\n`);
    return 0;
  }

  // The person's yes: refused unless a preview was built in the last hour (DECISIONS.md D72).
  if (f['yes'] === true) {
    if (f['apply'] !== true) {
      console.log('would turn model reads on. re-run with --yes --apply.');
      return 0;
    }
    const r = giveConsent(config.archive);
    if ('refused' in r) {
      console.log(`model reads stay off: ${r.refused}. /vibesenpai:judge on shows the preview first.`);
      return 1;
    }
    // A yes is also the explicit act that releases a hold after repeated paid failures.
    releaseHold(config.archive, 'judge');
    console.log('Model reads are on.');
    console.log(READS_LAST);
    return 0;
  }

  const on = readsOn(state.settings);
  console.log(`judge: model reads ${on ? 'on' : 'off until you say yes'}, model ${state.settings.model}`);
  console.log(`  limits   ${human(state.settings.dailyTokens)} tokens a day, catch-up on ${state.settings.catchUp} past sessions`);
  if (state.usage.calls > 0) {
    console.log(`  spent so far  ${state.usage.calls} call(s), ${state.usage.inputTokens.toLocaleString()} in, ${state.usage.outputTokens.toLocaleString()} out`);
  }

  if (f['dry-run'] === true || f['enable'] === true) {
    // The dry run shows the text itself, so it records nothing; `on` records the preview a yes will refer to.
    const p = previewNextPacket(config, f['dry-run'] !== true);
    console.log('');
    console.log(READS_WHERE);
    if (p.first.length === 0) {
      console.log('Nothing is waiting to be read right now.');
    } else {
      const ids = p.first.flatMap((x) => x.sessions);
      const tokens = p.first.reduce((n, x) => n + x.tokens, 0);
      console.log(`The first read would send ${plural(ids.length, 'session')} in ${plural(p.first.length, 'packet')}, about ${tokens.toLocaleString()} tokens.`);
      console.log(`After that, the reads would go through ${plural(p.then.sessions, 'session')} waiting now, about ${human(p.then.tokens)} tokens in all.`);
    }
    console.log(READS_REDACTION);
    console.log('');
    if (f['dry-run'] === true) {
      for (const [n, x] of p.first.entries()) {
        console.log(`----- packet ${n + 1} of ${p.first.length}: ${x.sessions.map((s) => s.sessionId.slice(0, 8)).join(', ')} -----`);
        console.log(x.text);
      }
      console.log('\n--dry-run: nothing was sent.');
      return 0;
    }
    console.log('The exact text is in /vibesenpai:insights.');
    console.log(READS_LAST);
    console.log(READS_COST);
    console.log('');
    console.log(on ? 'Model reads are already on.' : 'Nothing has been sent. /vibesenpai:judge yes turns them on.');
    return 0;
  }

  console.log('\n  --enable to see what would be sent, --dry-run to print it, --disable to stop.');
  return 0;
}
