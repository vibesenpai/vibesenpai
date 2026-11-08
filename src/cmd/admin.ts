/** Diagnostic commands: scan, config, doctor, skeleton, standing. */

import { homedir } from 'node:os';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { bold, dim } from '../style.ts';
import { join } from 'node:path';
import { type Layer } from '../config.ts';
import { describeCatalog, readCatalog, runScan } from '../catalog.ts';
import { parse, registry } from '../parsers/index.ts';
import { readJudgeState, tallyByDimension } from '../judge/state.ts';
import { detectorsFor, unknownDimensions } from '../detect/index.ts';
import { leadSegments } from '../render.ts';
import { jobsHealth, superviseAll } from '../jobs.ts';
import { readStanding } from '../standing.ts';
import { nextRung, reportBlock } from '../session-block.ts';
import { runAndWait } from '../spawn.ts';
import { localStamp } from '../format.ts';
import { type Argv, fmtBytes, configFromFlags, openSession, printSkeletons, judgePendingLine } from './common.ts';

export function cmdScan(a: Argv): number {
  const { config } = configFromFlags(a);
  const s = runScan({ sources: config.sources, catalog: config.archive });

  console.log(
    `scanned ${s.scanned} transcript${s.scanned === 1 ? '' : 's'} · ` +
      `${s.added} new, ${s.grown} grown, ${s.unchanged} unchanged` +
      (s.reset > 0 ? `, ${s.reset} re-read` : '') +
      (s.vanished > 0 ? `, ${s.vanished} deleted by the harness` : ''),
  );
  console.log(
    `read ${fmtBytes(s.bytesRead)}${s.bytesRead === 0 ? ' (nothing new)' : ''} · copied nothing`,
  );
  const d = describeCatalog(config.archive);
  console.log(
    `catalog · ${d.sessions} session${d.sessions === 1 ? '' : 's'}` +
      (d.gone > 0 ? ` (${d.gone} source${d.gone === 1 ? '' : 's'} since deleted)` : '') +
      ` · ${config.archive}`,
  );
  for (const sk of s.skipped) console.error(`skipped ${sk.path}: ${sk.reason}`);
  return 0;
}

export function cmdConfig(a: Argv): number {
  const { config, provenance, warnings } = configFromFlags(a);
  const show = (k: string, v: string, l: Layer): void =>
    console.log(`  ${k.padEnd(9)} ${v}  (${l})`);
  console.log('resolved config');
  show('sources', config.sources.join(', '), provenance.sources);
  show('archive', config.archive, provenance.archive);
  show('preset', config.preset, provenance.preset);
  show('mute', config.mute.length === 0 ? '(nothing)' : config.mute.join(', '), provenance.mute);

  console.log(
    `  ${'config'.padEnd(9)} ${config.configFile ?? '(none)'}` +
      `  (${config.configFile && existsSync(config.configFile) ? 'present' : 'absent'})`,
  );

  // Print rejected values, or provenance alone would hide that a setting was ignored.
  for (const w of warnings) console.error(`  ! ${w}`);

  const selected = detectorsFor(config.preset, undefined, config.mute);
  console.log(
    `\ndetectors for this config: ${selected.length === 0 ? '(none)' : selected.map((d) => d.dimension).join(', ')}`,
  );
  for (const u of unknownDimensions(config.mute)) {
    console.error(`  ! mute "${u}" names no dimension — nothing is silenced by it`);
  }
  return 0;
}

/** Report the harness's own retention. Read-only: we never write it. */
export function harnessTtlStatus(home: string): string[] {
  const settings = join(home, '.claude', 'settings.json');
  let configured: number | undefined;
  try {
    const raw = JSON.parse(readFileSync(settings, 'utf8')) as Record<string, unknown>;
    const v = raw['cleanupPeriodDays'];
    if (typeof v === 'number') configured = v;
  } catch {
    /* absent is normal */
  }
  const lines: string[] = [];
  if (configured === undefined) {
    lines.push('  harness    cleanupPeriodDays not set → Claude Code deletes after 30 days');
  } else {
    lines.push(`  harness    cleanupPeriodDays = ${configured} (your setting)`);
  }
  try {
    const stamp = readFileSync(join(home, '.claude', '.last-cleanup'), 'utf8').trim();
    lines.push(`             last cleanup: ${stamp}`);
  } catch {
    /* no stamp yet */
  }
  return lines;
}

export function cmdDoctor(a: Argv): number {
  const home = homedir();
  const { config } = configFromFlags(a);
  console.log('vibesenpai doctor\n');

  console.log(`  node       ${process.version}`);

  for (const s of config.sources) {
    let detail = 'not present';
    try {
      if (statSync(s).isDirectory()) detail = 'present';
    } catch {
      /* not present */
    }
    console.log(`  source     ${s}  (${detail})`);
  }

  // Background jobs: what each is doing, and why one is not.
  const jobs = jobsHealth(config.archive);
  for (const j of jobs) {
    const state =
      j.state === 'retrying'
        ? `retrying · ${j.failures} failure(s) since ${localStamp(j.since)} · next try ${localStamp(j.retryAt)}`
        : j.state === 'held'
          ? `held after ${j.paidFailures} failed paid calls · \`judge --enable --apply\` releases it`
          : j.state;
    console.log(`  ${`job ${j.job}`.padEnd(13)}${state}`);
    if (j.state === 'retrying' || j.state === 'held') console.log(`             ${j.reason}`);
  }
  const st = readStanding(config.archive);
  console.log(
    st === undefined
      ? `  report     nothing computed yet — runs when a session starts`
      : `  report     ${st.sessions} session(s), ${st.edits} edits, computed ${localStamp(st.computedAt)}`,
  );
  // Exactly what a new session will show.
  const js = readJudgeState(config.archive);
  const block = reportBlock(st, nextRung('block'), tallyByDimension(js), js.dismissed ?? 0, jobs);
  if (block !== '') for (const l of block.split('\n')) console.log(`             ${l}`);
  if (process.env['VIBESENPAI_DISABLE'] === '1') {
    console.log(`  ambient    VIBESENPAI_DISABLE=1 is set — every hook exits on line one`);
  }

  const d = describeCatalog(config.archive);
  console.log(`  store      ${config.archive}`);
  console.log(
    `             ${d.sessions} session${d.sessions === 1 ? '' : 's'} catalogued` +
      (d.gone > 0 ? `, ${d.gone} source${d.gone === 1 ? '' : 's'} since deleted` : '') +
      ` · ${fmtBytes(d.bytesTracked)} of source read`,
  );
  console.log('             no transcript copies are kept — sources are read in place');

  let mode = 'absent';
  try {
    mode = (statSync(config.archive).mode & 0o777).toString(8);
  } catch {
    /* absent */
  }
  console.log(`             permissions ${mode}${mode === '700' || mode === 'absent' ? '' : '  ⚠ expected 700'}`);

  // Harness versions in the archive; an untested one is reported, not hidden.
  console.log('  parsers');
  for (const p of registry.list()) {
    console.log(`             ${p.id}  tested: ${Object.keys(p.testedVersions).join(', ')}`);
  }
  const index = readCatalog(config.archive);
  if (index) {
    const seen = new Map<string, { n: number; match: string }>();
    for (const e of Object.values(index.entries)) {
      try {
        const r = parse(e.source, readFileSync(e.source, 'utf8'), e.sessionId);
        const key = r.provenance.version ?? '(none)';
        const cur = seen.get(key);
        if (cur) cur.n++;
        else seen.set(key, { n: 1, match: r.provenance.match });
      } catch {
        /* a source we can no longer read is reported as `gone` above */
      }
    }
    if (seen.size > 0) {
      console.log('  archive versions');
      for (const [v, { n, match }] of [...seen].sort()) {
        const flag = match === 'exact' ? '' : `  ⚠ ${match} — findings may be incomplete`;
        console.log(`             ${v.padEnd(10)} ${n} session${n === 1 ? '' : 's'}  ${match}${flag}`);
      }
    }
  }
  // Must match .claude/rules/judge.md.
  const judgeOn = readJudgeState(config.archive).settings.enabled;
  console.log(`  network    ${judgeOn ? 'the judge is ON and sends session content' : 'no network calls, with one opt-in exception'}`);
  if (judgeOn) {
    console.log('             redacted transcript text leaves this machine when the judge');
    console.log('             runs, and only when you run a command. --disable to stop it.');
    console.log('             turn it off:  vibesenpai judge --disable --apply');
  } else {
    console.log('             the judge would send redacted session content to a model, and');
    console.log('             it is OFF. Nothing else reaches the network during analysis;');
    console.log('             the model download is setup, and hooks cannot trigger it.');
  }
  console.log('');
  for (const l of harnessTtlStatus(home)) console.log(l);
  return 0;
}

export function cmdSkeleton(a: Argv): number {
  const sessionId = a._[1];
  if (sessionId === undefined) {
    console.error('usage: vibesenpai skeleton <sessionId> [--live] [--window n]');
    return 1;
  }
  const { config } = configFromFlags(a);
  const { source, offset } = openSession(a, sessionId, config);
  return printSkeletons(a, sessionId, source, offset);
}

/** Print the stored standing pass, the same one session start shows. `--refresh` recomputes first. */
export async function cmdStanding(a: Argv): Promise<number> {
  const { config } = configFromFlags(a);

  if (a.flags['refresh'] === true) {
    try {
      runAndWait('compute-standing.ts', ['--force'], { inherit: true });
    } catch {
      console.error('the standing pass failed — see `vibesenpai doctor`.');
      return 1;
    }
  }

  const s = readStanding(config.archive);
  if (s === undefined) {
    console.log('no standing yet.');
    console.log('  it is computed when a session starts, or now with --refresh.');
    return 0;
  }

  // Same ladder as `now` and the report: cost, then a count, then a statement.
  const ruleCount = s.dimensions.reduce((n, d) => n + d.occurrences, 0);
  const js = readJudgeState(config.archive);
  const judgedCount = tallyByDimension(js).reduce(
    (n, j) => n + j.count,
    0,
  );
  const seg = leadSegments({
    ruleCount,
    judgedCount,
    total: ruleCount + judgedCount,
    wasted: Object.values(s.wastedTokens).reduce((n, w) => n + w.written, 0),
    editCount: s.edits,
  });
  console.log(seg.figure === undefined ? seg.rest : `${bold(seg.figure)}${seg.rest}`);
  console.log(dim(`  ${s.sessions} session(s) · ${s.edits} edits · computed ${localStamp(s.computedAt)}`));
  if (s.unreadable > 0) {
    // Stated, so coverage is never implied.
    console.log(`  ${s.unreadable} session(s) could not be read`);
  }

  // Before the findings, so "no findings" is not read as final while a pass is pending.
  const pendingLine = judgePendingLine(config);
  if (pendingLine !== undefined) console.log(`\n  ${pendingLine}`);

  if (s.dimensions.length === 0) {
    console.log(`\n  no findings across ${s.edits} edits`);
  } else {
    console.log('');
    for (const d of s.dimensions) {
      console.log(
        `  ${d.dimension.padEnd(16)} ${d.occurrences} occurrence(s) across ${d.sessions} session(s)`,
      );
    }
    const reasons = Object.entries(s.reasons).sort((x, y) => y[1] - x[1]);
    if (reasons.length > 0) {
      console.log('');
      for (const [reason, n] of reasons) console.log(`    ${String(n).padStart(3)}  ${reason}`);
    }
  }

  const block = reportBlock(s, nextRung('block'), tallyByDimension(js), js.dismissed ?? 0);
  if (block !== '') {
    console.log('\n  a new session shows:');
    for (const l of block.split('\n')) console.log(`    ${l}`);
  }
  return 0;
}

/**
 * `tick`: one supervisor pass, for any harness or scheduler that is not the plugin's hooks.
 * Free jobs only unless `--judge`: no command spends by accident.
 */
export function cmdTick(a: Argv): number {
  const { config } = configFromFlags(a);
  const decided = superviseAll(config, { judge: a.flags['judge'] === true });
  for (const [job, what] of Object.entries(decided)) console.log(`${job.padEnd(10)} ${what}`);
  return 0;
}
