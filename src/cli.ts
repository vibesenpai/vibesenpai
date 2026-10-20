#!/usr/bin/env node
/**
 * CLI entry. The secondary surface — the harness is primary (see docs/surfaces.md).
 *
 * M1 scope: `scan`, `doctor`, `config`, `skeleton`, `now`, `report`. The last
 * three are shaped now and answer "no detectors yet" until M2a — the shape is
 * settled early because retrofitting it after the detectors exist is the
 * expensive order.
 */

import { homedir } from 'node:os';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig, type Layer } from './config.ts';
import { describeCatalog, readCatalog, runScan } from './catalog.ts';
import { parse, registry } from './parsers/index.ts';
import { readSession, resolveCurrentSession, findSessionSource } from './read.ts';
import { buildSkeletons, render } from './skeleton.ts';
import { describeCoverage, resolveRange, segmentByDepth } from './report.ts';
import { countDenominators, detectorsFor, runDetectors, unknownDimensions } from './detect/index.ts';
import { render as renderFindings } from './render.ts';
import type { Detector } from './detect/index.ts';
import type { Preset } from './types.ts';
import { addHook, describeChange, dropOurStatusLine, planFor, remove, type Settings } from './install.ts';
import { readBreaker, isTripped } from './breaker.ts';
import { computedAtLocal, readStanding } from './standing.ts';
import { reportBlock } from './report-line.ts';
import { spawn } from 'node:child_process';
import { copyFileSync, writeFileSync } from 'node:fs';

type Argv = { _: string[]; flags: Record<string, string | boolean | string[]> };

function parseArgv(argv: string[]): Argv {
  const out: Argv = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out.flags[key] = true;
    } else {
      // Repeatable flags collect into an array even when given once, so a
      // single `--mute x` is not silently a string the caller then drops.
      if (key === 'source' || key === 'mute') {
        const prev = out.flags[key];
        out.flags[key] = Array.isArray(prev) ? [...prev, next] : [next];
      } else {
        out.flags[key] = next;
      }
      i++;
    }
  }
  return out;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

function configFromFlags(a: Argv) {
  const f = a.flags;
  const sources = f['source'];
  return resolveConfig({
    flags: {
      ...(Array.isArray(sources) ? { sources } : {}),
      ...(typeof f['archive'] === 'string' ? { archive: f['archive'] } : {}),
      ...(typeof f['models'] === 'string' ? { models: f['models'] } : {}),
      ...(typeof f['config'] === 'string' ? { config: f['config'] } : {}),
      ...(typeof f['preset'] === 'string' ? { preset: f['preset'] } : {}),
      ...(Array.isArray(f['mute']) ? { mute: f['mute'] as string[] } : {}),
    },
  });
}

/**
 * The detectors this invocation will run, with the user's choices applied.
 *
 * Warnings are printed rather than thrown. A bad preset or a mistyped mute
 * entry should not stop the analysis — but it must not pass silently either,
 * because believing a dimension is muted when it is not is worse than an error.
 */
function detectorsFromConfig(cfg: { preset: Preset; mute: string[] }): Detector[] {
  for (const w of unknownDimensions(cfg.mute)) {
    console.error(`warning: --mute ${w} names no dimension — nothing was silenced by it`);
  }
  return detectorsFor(cfg.preset, undefined, cfg.mute);
}

const USAGE = `agentsensei — find the turns where you and your agent wasted effort

Usage
  agentsensei scan               read new transcript data (copies nothing)
  agentsensei doctor             harnesses, paths, parser coverage
  agentsensei config             resolved values and which layer set each
  agentsensei skeleton <id>      print a session's windows as evidence
  agentsensei now                the session you are in, read live
  agentsensei report             retrospective over a date range
  agentsensei standing          what your history says (the baseline)
  agentsensei install           add the hooks + statusline (prints first)
  agentsensei uninstall         take them back out

Options
  --source <path>    transcript source (repeatable)
  --archive <path>   store location (catalog + findings)
  --models <path>    model location
  --config <path>    config file

dimensions
  --preset <name>    core | standard | all   (default core)
  --mute <name>      silence a dimension (repeatable); wins over everything

skeleton / now
  --live             read past the catalog offset, to the end of the file
  --session <id>     which session \`now\` should read
  --skeleton         also dump the token-budget windows (debug view)
  --window <n>       print only window n (1-based)

standing
  --refresh          recompute from every transcript now, in the foreground

install / uninstall
  (prints what it would do and writes NOTHING by default)
  --apply            actually write it; a backup is taken first
  --print-only       emit the fragments to merge by hand, write nothing

report
  --last <7d|4w|6m>  relative range (default 7d)
  --since <date>     YYYY-MM-DD, with --until
  --until <date>     YYYY-MM-DD
  --project <name>   accepted, not yet applied (needs M2a findings)

Not yet implemented (see PLAN.md): fix, explain, claude-md, eval, trends,
and the ambient statusline.
`;

function cmdScan(a: Argv): number {
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

function cmdConfig(a: Argv): number {
  const { config, provenance, warnings } = configFromFlags(a);
  const show = (k: string, v: string, l: Layer): void =>
    console.log(`  ${k.padEnd(9)} ${v}  (${l})`);
  console.log('resolved config');
  show('sources', config.sources.join(', '), provenance.sources);
  show('archive', config.archive, provenance.archive);
  show('models', config.models, provenance.models);
  show('preset', config.preset, provenance.preset);
  show('mute', config.mute.length === 0 ? '(nothing)' : config.mute.join(', '), provenance.mute);

  console.log(
    `  ${'config'.padEnd(9)} ${config.configFile ?? '(none)'}` +
      `  (${config.configFile && existsSync(config.configFile) ? 'present' : 'absent'})`,
  );

  // A rejected value is printed, never swallowed: provenance alone would show
  // `preset core (default)` and leave someone believing they had set `all`.
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

/**
 * Report the harness's own retention. Read-only, always — we never write it, and
 * we no longer mirror it either, because we keep no copies to prune.
 */
function harnessTtlStatus(home: string): string[] {
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

function cmdDoctor(a: Argv): number {
  const home = homedir();
  const { config } = configFromFlags(a);
  console.log('agentsensei doctor\n');

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

  // The ambient layer's own health. "Degrading to silence beats degrading to
  // noise" is only honest if something says when it has gone silent.
  const breaker = readBreaker(config.archive);
  if (isTripped(breaker)) {
    console.log(
      `  ambient    DISABLED after ${breaker.consecutiveFailures} consecutive failures` +
        (breaker.trippedAt !== undefined ? ` (since ${breaker.trippedAt.slice(0, 16)})` : ''),
    );
    console.log(`             ${breaker.reason ?? 'no reason recorded'}`);
    console.log(`             one successful analysis closes it; nothing to reset by hand`);
  } else if (breaker.consecutiveFailures > 0) {
    console.log(`  ambient    ${breaker.consecutiveFailures} recent failure(s), still enabled`);
  } else {
    const st = readStanding(config.archive);
    console.log(
      st === undefined
        ? `  report     nothing computed yet — runs when a session starts`
        : `  report     ${st.sessions} session(s), ${st.edits} edits, computed ${computedAtLocal(st)}`,
    );
    // Exactly what a new session will show, so `doctor` answers "what will I
    // see" rather than only "is it alive".
    const block = reportBlock(st);
    if (block !== '') for (const l of block.split('\n')) console.log(`             ${l}`);
  }
  if (process.env['AGENTSENSEI_DISABLE'] === '1') {
    console.log(`  ambient    AGENTSENSEI_DISABLE=1 is set — every hook exits on line one`);
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
  console.log(`  models     ${config.models}  (not installed)`);

  // Parser coverage: which harness versions the archive actually holds, and
  // whether a measured strategy claims each one. A version we have never read
  // is reported, not hidden — findings from it may be incomplete.
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
  console.log('  network    no network calls during analysis');
  console.log('             the only network access is the opt-in model download, which is');
  console.log('             setup rather than analysis — hooks can never trigger it');
  console.log('');
  for (const l of harnessTtlStatus(home)) console.log(l);
  return 0;
}


/**
 * Resolve a session to a source path plus the catalog offset, if it has one.
 *
 * `--live` is what makes this work on the session you are currently in: that
 * transcript is being appended to right now and no scan has reached its tail.
 */
function openSession(
  a: Argv,
  sessionId: string,
  config: { sources: string[]; archive: string },
): { source: string; offset: number | undefined } {
  const live = a.flags['live'] === true;
  const index = readCatalog(config.archive);
  const entry = index
    ? Object.values(index.entries).find((e) => e.sessionId === sessionId)
    : undefined;

  const source = entry?.source ?? findSessionSource(config.sources, sessionId);
  if (source === undefined) {
    throw new Error(
      `no transcript found for session ${sessionId}\n` +
        `searched: ${config.sources.join(', ')}`,
    );
  }
  if (entry?.gone !== undefined) {
    throw new Error(
      `the transcript for ${sessionId} was deleted by the harness on ` +
        `${entry.gone.slice(0, 10)} — evidence for it is no longer readable`,
    );
  }
  return { source, offset: live ? undefined : entry?.offset };
}

function printSkeletons(
  a: Argv,
  sessionId: string,
  source: string,
  offset: number | undefined,
  // `now` is live by definition; `skeleton` must not silently become live, or
  // readSession's "not in the catalog" refusal is decoration that never fires.
  allowLiveFallback = false,
): number {
  const explicitLive = a.flags['live'] === true;
  if (!explicitLive && offset === undefined && !allowLiveFallback) {
    throw new Error(
      `${sessionId} is not in the catalog yet — run \`agentsensei scan\`, ` +
        `or pass --live to read the source as it is on disk now`,
    );
  }
  const mode = explicitLive || offset === undefined ? 'live' : 'catalogued';
  const read = readSession({ source, sessionId, mode, ...(offset !== undefined ? { catalogOffset: offset } : {}) });

  const parsed = parse(source, read.text, sessionId);
  const skeletons = buildSkeletons(sessionId, parsed.events);

  console.log(
    `${sessionId} · ${mode} · ${fmtBytes(read.bytesRead)}` +
      (read.ahead > 0 ? ` (${fmtBytes(read.ahead)} past the last scan)` : '') +
      (read.partialTail ? ' · a partial trailing line was left unread' : ''),
  );
  console.log(
    `${parsed.events.length} events · ${skeletons.length} window${skeletons.length === 1 ? '' : 's'}` +
      (parsed.malformed > 0 ? ` · ${parsed.malformed} malformed line(s)` : '') +
      (parsed.abandoned > 0 ? ` · ${parsed.abandoned} on abandoned branches` : '') +
      ` · parser ${parsed.provenance.version ?? '(no version)'} ${parsed.provenance.match}`,
  );

  if (skeletons.length === 0) {
    console.log('\nno windows — the session produced no analysable turns');
    return 0;
  }

  const pick = a.flags['window'];
  const only = typeof pick === 'string' ? Number(pick) : undefined;
  if (only !== undefined && (!Number.isInteger(only) || only < 1 || only > skeletons.length)) {
    throw new Error(`--window expects 1..${skeletons.length} (got "${String(pick)}")`);
  }

  const shown = only === undefined ? skeletons : [skeletons[only - 1] as (typeof skeletons)[number]];
  for (const [i, sk] of shown.entries()) {
    const n = only ?? i + 1;
    const tag = sk.sidechainId !== undefined ? `  [subagent ${sk.sidechainId.slice(0, 8)}]` : '';
    console.log(`\n── window ${n}/${skeletons.length}${tag}`);
    console.log(render(sk));
  }
  return 0;
}

function cmdSkeleton(a: Argv): number {
  const sessionId = a._[1];
  if (sessionId === undefined) {
    console.error('usage: agentsensei skeleton <sessionId> [--live] [--window n]');
    return 1;
  }
  const { config } = configFromFlags(a);
  const { source, offset } = openSession(a, sessionId, config);
  return printSkeletons(a, sessionId, source, offset);
}

/**
 * The in-session view. Reads live by definition — the point is the turns that
 * have happened since the last scan, which is to say the ones you just made.
 */
async function cmdNow(a: Argv): Promise<number> {
  const { config } = configFromFlags(a);
  const flagSession = a.flags['session'];
  const current = resolveCurrentSession(config.sources, {
    ...(typeof flagSession === 'string' ? { sessionId: flagSession } : {}),
  });

  if (current === undefined) {
    console.error(`no transcript found under: ${config.sources.join(', ')}`);
    return 1;
  }
  if (current.via === 'latest') {
    // Named, not assumed. A wrong guess must be visible rather than producing
    // authoritative-looking output about somebody else's session.
    console.log(`(guessed the most recently written transcript — override with --session)`);
  }

  a.flags['live'] = true;

  // Live by definition: the interesting turns are the ones since the last scan,
  // which is to say the ones just made. `readSession` already tails past the
  // catalogued offset, so this is a parameter rather than a second code path.
  const read = readSession({ source: current.source, sessionId: current.sessionId, mode: 'live' });
  const parsed = parse(current.source, read.text, current.sessionId);

  const detectors = detectorsFromConfig(config);
  const res = await runDetectors({
    events: parsed.events,
    session: { sessionId: current.sessionId, project: projectOf(current.source), live: true },
    detectors,
  });

  process.stdout.write(
    renderFindings({
      findings: res.findings,
      denominators: res.denominators,
      sessionId: current.sessionId,
      events: parsed.events,
      ...(config.mute.length > 0 ? { muted: config.mute } : {}),
    }),
  );

  for (const [dim, n] of Object.entries(res.failures)) {
    // Never swallowed: a silent zero would read as "nothing found".
    console.error(`warning: ${dim} failed ${n}x and reported nothing`);
  }
  if (detectors.length === 0) {
    console.error(
      `warning: preset "${config.preset}" selected no detectors — nothing could be found`,
    );
  }

  // The window dump is a debug view, not the product. `agentsensei skeleton`
  // exists for it; `--skeleton` keeps it reachable from here too.
  if (a.flags['skeleton'] === true) {
    return printSkeletons(a, current.sessionId, current.source, undefined, true);
  }
  return 0;
}

/**
 * The project a transcript belongs to.
 *
 * The harness encodes it in the directory name; findings are keyed on it so the
 * same subject in two projects is two subjects.
 */
function projectOf(source: string): string {
  const parts = source.split(/[\\/]/).filter((p) => p !== '');
  return parts.at(-2) ?? 'unknown';
}

/** Where this checkout lives, so the installed commands are absolute. */
function repoRoot(): string {
  return join(import.meta.dirname, '..');
}

function settingsPath(home: string): string {
  return join(home, '.claude', 'settings.json');
}

function readSettings(path: string): Settings {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Settings;
  } catch {
    return {};
  }
}

/**
 * Install the ambient surface into the harness's settings.
 *
 * ── Safe by default ────────────────────────────────────────────────────────
 *
 * Prints what it would do and writes nothing. The write needs `--apply`, which
 * is consent by explicit act rather than a prompt nobody reads — and it means
 * the dangerous path cannot be reached by a typo or a stray shell history entry.
 *
 * Writing someone's config is the "Self-Initiated Overreach" failure this tool
 * exists to detect, so: a timestamped backup first, a merge that touches only
 * our own entries, and a re-read afterwards that restores the backup if what
 * landed is not what was intended.
 */
function cmdInstall(a: Argv): number {
  const home = typeof a.flags['home'] === 'string' ? a.flags['home'] : homedir();
  const path = settingsPath(home);
  const before = readSettings(path);
  const plan = planFor(repoRoot());

  // No statusline. It cost a permanent row of screen for one rarely-changing
  // line, and **no official plugin ships one** — the report goes in the main
  // window at session start instead. Your status bar stays yours.
  //
  // `dropOurStatusLine` is for upgrades: the previous version set one pointing
  // at a script that no longer exists, and leaving it would have the harness
  // run a guaranteed-failing command on every render.
  const after = addHook(dropOurStatusLine(before), plan);

  if (a.flags['print-only'] === true) {
    // **Fragments, not the whole file.** Printing the merged settings would
    // invite pasting it over the original, which discards whatever formatting
    // was there and makes the merge guarantee pointless — the one path where
    // "we never replace your config" could be defeated by following our own
    // instructions.
    const ours = (after.hooks?.['Stop'] ?? [])
      .flatMap((m) => m.hooks)
      .filter((h) => h.__agentsensei === true);
    console.log(`// add to hooks.Stop in ${path} — keep your existing entries`);
    console.log(JSON.stringify({ hooks: { Stop: [{ hooks: ours }] } }, null, 2));
    console.log('\n// these are fragments to merge, NOT a replacement file.');
    return 0;
  }

  const change = describeChange(before, after);
  console.log(`settings: ${path}\n`);
  if (change.length === 0) {
    console.log('already installed — nothing would change.');
    return 0;
  }
  console.log('this would change:');
  for (const l of change) console.log(l);

  if (a.flags['apply'] !== true) {
    console.log('\nnothing written. re-run with --apply to write it,');
    console.log('or --print-only for the fragments to merge in by hand.');
    console.log('`agentsensei uninstall --apply` reverses exactly this.');
    return 0;
  }

  const backup = `${path}.agentsensei-backup`;
  try {
    copyFileSync(path, backup);
  } catch {
    console.error(`could not back up ${path} — refusing to write without one.`);
    return 1;
  }

  writeFileSync(path, `${JSON.stringify(after, null, 2)}\n`);

  // Re-read and verify. A merge that produced something else must not stand,
  // and the backup is right there.
  const verify = readSettings(path);
  if (JSON.stringify(verify) !== JSON.stringify(after)) {
    copyFileSync(backup, path);
    console.error('\nwhat landed was not what was intended — restored from backup.');
    return 1;
  }

  console.log(`\nwritten. backup at ${backup}`);
  console.log('reverse it with `agentsensei uninstall --apply`.');

  // Process history right now rather than waiting for the next session to open.
  // The harness deletes transcripts after `cleanupPeriodDays` (30 by default)
  // and we keep no copies, so waiting is not neutral — it loses data.
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', join(repoRoot(), 'scripts', 'compute-standing.ts'), '--force'],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  console.log(
    '\nagentsensei has started reading your existing transcripts and will report\n' +
      'back shortly — sit tight. Nothing is copied; they are read in place.\n' +
      '  `agentsensei standing` shows the result, and the statusline will pick it\n' +
      '  up on its own at the next response boundary.',
  );
  return 0;
}

/**
 * What history says. The baseline a new install arrives with.
 *
 * Reads the stored pass rather than computing, so this is instant and shows
 * exactly what the statusline will show. `--refresh` recomputes in the
 * foreground, for when somebody wants it now.
 */
async function cmdStanding(a: Argv): Promise<number> {
  const { config } = configFromFlags(a);

  if (a.flags['refresh'] === true) {
    const { execFileSync } = await import('node:child_process');
    try {
      execFileSync(
        process.execPath,
        ['--experimental-strip-types', join(repoRoot(), 'scripts', 'compute-standing.ts'), '--force'],
        { stdio: 'inherit' },
      );
    } catch {
      console.error('the standing pass failed — see `agentsensei doctor`.');
      return 1;
    }
  }

  const s = readStanding(config.archive);
  if (s === undefined) {
    console.log('no standing yet.');
    console.log('  it is computed when a session starts, or now with --refresh.');
    return 0;
  }

  console.log(`standing · computed ${computedAtLocal(s)}`);
  console.log(`  ${s.sessions} session(s) · ${s.edits} edits`);
  if (s.unreadable > 0) {
    // Stated, never dropped: a standing that quietly covered fewer sessions
    // than it claims is the implied-coverage problem depth labelling prevents.
    console.log(`  ${s.unreadable} session(s) could not be read`);
  }

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

  if (s.tokens.output > 0) {
    const ratio = s.tokens.cacheCreation / s.tokens.output;
    console.log(
      `\n  ${(s.tokens.output / 1e6).toFixed(1)}M out · ` +
        `${(s.tokens.cacheCreation / 1e6).toFixed(1)}M re-ingested · ratio ${ratio.toFixed(1)}`,
    );
  }

  const block = reportBlock(s);
  if (block !== '') {
    console.log('\n  a new session shows:');
    for (const l of block.split('\n')) console.log(`    ${l}`);
  }
  return 0;
}

/** Take ours out and leave everything else exactly as it was. */
function cmdUninstall(a: Argv): number {
  const home = typeof a.flags['home'] === 'string' ? a.flags['home'] : homedir();
  const path = settingsPath(home);
  const before = readSettings(path);
  const after = remove(before);

  const change = describeChange(before, after);
  console.log(`settings: ${path}\n`);
  if (change.length === 0) {
    console.log('nothing of ours is installed.');
    return 0;
  }
  console.log('this would change:');
  for (const l of change) console.log(l);

  if (a.flags['apply'] !== true) {
    console.log('\nnothing written. re-run with --apply.');
    return 0;
  }
  writeFileSync(path, `${JSON.stringify(after, null, 2)}\n`);
  console.log('\nremoved.');
  return 0;
}

async function cmdReport(a: Argv): Promise<number> {
  const { config } = configFromFlags(a);
  const f = a.flags;
  const range = resolveRange(
    {
      ...(typeof f['last'] === 'string' ? { last: f['last'] } : {}),
      ...(typeof f['since'] === 'string' ? { since: f['since'] } : {}),
      ...(typeof f['until'] === 'string' ? { until: f['until'] } : {}),
    },
    new Date(),
  );
  if (!range.ok) {
    console.error(range.error);
    return 1;
  }

  const d = describeCatalog(config.archive);
  const segments = segmentByDepth(range.range, {
    // One interval per session, not a single start boundary: a gap between
    // sessions must stay visible rather than being reported as covered.
    covered: d.spans.map((s) => ({ from: new Date(s.from), to: new Date(s.to) })),
    scanned: d.sessions > 0,
    // `history.jsonl` parsing is an M2 deliverable, so the shallow tier has no
    // backing yet. Claiming it now would promise depth we cannot deliver.
    hasPromptHistory: false,
  });

  const project = typeof f['project'] === 'string' ? f['project'] : undefined;
  console.log(
    `report · ${range.range.from.toISOString().slice(0, 10)} → ` +
      `${range.range.to.toISOString().slice(0, 10)}`,
  );
  if (project !== undefined) {
    // Printing `· project ~ode` in the header read as "restricted to that
    // project" while nothing was filtered — the same implied-coverage problem as
    // the depth labelling, one line further down.
    console.log(`  note: --project ${project} is accepted but not yet applied`);
  }
  console.log('\ncoverage');
  for (const l of describeCoverage(segments)) console.log(l);

  // Findings are recomputed rather than read from a store. Measured on real
  // transcripts: parse is 95% of the cost (423ms for 19.9MB) and detection 5%,
  // so ~2s across the design target of 40 sessions. Persistence buys trends,
  // surfaced-dedup and dismissals — none of which this surface needs yet, and
  // a store that can disagree with the transcript is worse than a short wait.
  const detectors = detectorsFromConfig(config);
  if (detectors.length === 0) {
    console.error(`\nwarning: preset "${config.preset}" selected no detectors`);
    return 0;
  }

  // Entries, not `describeCatalog`'s spans: the entry carries the session id and
  // the source path, so there is nothing to look up and nothing to mismatch.
  const catalog = readCatalog(config.archive);
  const inRange = Object.values(catalog?.entries ?? {}).filter((e) => {
    if (e.gone !== undefined) return false; // the harness TTL took it
    const t = Date.parse(e.firstTs ?? e.firstSeenAt);
    return (
      Number.isFinite(t) && t >= range.range.from.getTime() && t <= range.range.to.getTime()
    );
  });

  if (inRange.length === 0) {
    console.log('\nno catalogued sessions in this range');
    return 0;
  }

  console.log(`\nfindings · ${inRange.length} session(s) re-analysed`);
  let total = 0;
  let unreadable = 0;
  const byDimension = new Map<string, number>();

  for (const entry of inRange.sort((x, y) => (x.firstTs ?? '').localeCompare(y.firstTs ?? ''))) {
    let parsed;
    try {
      const read = readSession({ source: entry.source, sessionId: entry.sessionId, mode: 'live' });
      parsed = parse(entry.source, read.text, entry.sessionId);
    } catch {
      // Catalogued but no longer readable. Counted, not silently skipped: a
      // report that quietly analysed fewer sessions than it claimed is the
      // implied-coverage problem the depth labelling exists to prevent.
      unreadable++;
      continue;
    }
    const res = await runDetectors({
      events: parsed.events,
      session: {
        sessionId: entry.sessionId,
        project: projectOf(entry.source),
        live: false,
      },
      detectors,
    });
    for (const fi of res.findings) {
      total++;
      byDimension.set(fi.dimension, (byDimension.get(fi.dimension) ?? 0) + fi.occurrences);
    }
    if (res.findings.length > 0) {
      process.stdout.write(
        renderFindings({
          findings: res.findings,
          denominators: res.denominators,
          sessionId: entry.sessionId,
          events: parsed.events,
        }),
      );
    }
  }

  if (unreadable > 0) {
    console.log(`  ${unreadable} catalogued session(s) could no longer be read`);
  }
  if (total === 0) {
    console.log('  none');
  } else {
    console.log('  by dimension');
    for (const [dim, n] of [...byDimension].sort((x, y) => y[1] - x[1])) {
      console.log(`    ${dim.padEnd(20)} ${n} occurrence(s)`);
    }
  }
  if (config.mute.length > 0) console.log(`  muted: ${config.mute.join(', ')}`);
  return 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const a = parseArgv(argv);
  const cmd = a._[0];
  switch (cmd) {
    case 'scan':
      return cmdScan(a);
    case 'doctor':
      return cmdDoctor(a);
    case 'config':
      return cmdConfig(a);
    case 'skeleton':
      return cmdSkeleton(a);
    case 'now':
      return cmdNow(a);
    case 'report':
      return cmdReport(a);
    case 'standing':
      return cmdStanding(a);
    case 'install':
      return cmdInstall(a);
    case 'uninstall':
      return cmdUninstall(a);
    case undefined:
    case 'help':
      console.log(USAGE);
      return 0;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.error(USAGE);
      return 1;
  }
}

if (import.meta.filename === process.argv[1]) {
  try {
    process.exit(await main());
  } catch (err) {
    // A bad flag is a user error, not a crash. No stack trace.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
