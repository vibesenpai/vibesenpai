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
import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { resolveConfig, type Layer } from './config.ts';
import { describeCatalog, readCatalog, runScan } from './catalog.ts';
import { parse, registry } from './parsers/index.ts';
import {
  discoverTranscripts, findSessionSource, lookupSession, readSession, resolveCurrentSession,
  MIN_ID_PREFIX, type SessionLookup,
} from './read.ts';
import { gatherReport, type ReportData } from './gather.ts';
import {
  BYTES_PER_TURN, findingsFor, readJudgeState, writeJudgeState,
} from './judge-store.ts';
import { buildSession, renderPacket } from './judge.ts';
import { parseTranscript, withFullText } from './parsers/claude-code.ts';
import { renderHtml } from './html.ts';
import { buildSkeletons, render } from './skeleton.ts';
import { describeCoverage, resolveRange, segmentByDepth } from './report.ts';
import { detectorsFor, runDetectors, unknownDimensions } from './detect/index.ts';
import { render as renderFindings } from './render.ts';
import type { Detector } from './detect/index.ts';
import type { Preset } from './types.ts';
import {
  addHook, commandDir, commandFileBody, commandFilePath, describeChange, dropOurStatusLine,
  fixCommandBody, fixCommandFilePath, generateReportCommandBody, generateReportCommandFilePath,
  legacyCommandFiles, ourCommandFiles, planFor, remove, type Settings,
} from './install.ts';
import { readBreaker, isTripped } from './breaker.ts';
import { computedAtLocal, readStanding } from './standing.ts';
import { detailLine, reportBlock, fixLine } from './report-line.ts';
import { recommend, renderFix } from './fix.ts';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';

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
  agentsensei fix               one evidence-backed change to try
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

Not yet implemented: explain, claude-md, eval, trends.
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
    const block = reportBlock(st, detailLine(repoRoot(), home));
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
  // ── Say what is true, including the part that is awkward ─────────────────
  //
  // This printed "no network calls during analysis" and had done since before
  // the judge existed. The judge sends session content to a model, so the
  // guarantee was false for anyone who had turned it on — and this is the
  // screen a careful user reads precisely to check that claim.
  //
  // CLAUDE.md's "The judge may send session content, and only on these terms"
  // is the authority; this mirrors it rather than restating it loosely.
  const judgeOn = readJudgeState(config.archive).settings.enabled;
  console.log(`  network    ${judgeOn ? 'the judge is ON and sends session content' : 'no network calls, with one opt-in exception'}`);
  if (judgeOn) {
    console.log('             redacted transcript text leaves this machine when the judge');
    console.log('             runs. It is off by default and you turned it on.');
    console.log('             turn it off:  agentsensei judge --disable --apply');
  } else {
    console.log('             the judge would send redacted session content to a model, and');
    console.log('             it is OFF. Nothing else reaches the network during analysis;');
    console.log('             the model download is setup, and hooks cannot trigger it.');
  }
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

  // The pointer to `fix`, offered only when there is something to act on:
  // findings here, or a standing that has some. Nothing to fix means no line.
  const standing = readStanding(config.archive);
  const haveHistory = standing !== undefined && standing.dimensions.length > 0;
  const nextStep =
    res.findings.length > 0 || haveHistory
      ? fixLine(repoRoot(), homedir(), res.findings.length > 0)
      : '';

  // Precomputed by the detached pass — `now` reports, it never judges. That is
  // what keeps this surface instant.
  const judgeState = readJudgeState(config.archive);
  const judgedFindings = findingsFor(judgeState, current.sessionId);
  const judgedBytes = judgeState.ledger[current.sessionId] ?? 0;
  let unjudgedTurns = 0;
  try {
    unjudgedTurns = Math.max(
      0,
      Math.floor((statSync(current.source).size - judgedBytes) / BYTES_PER_TURN),
    );
  } catch {
    // Unreadable size is not worth failing over; the lag line is simply absent.
  }

  process.stdout.write(
    renderFindings({
      findings: res.findings,
      denominators: res.denominators,
      sessionId: current.sessionId,
      events: parsed.events,
      ...(judgeState.settings.enabled
        ? { judged: { findings: judgedFindings, unjudgedTurns } }
        : {}),
      ...(nextStep !== '' ? { nextStep } : {}),
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

  // ── Command files count as a change, settings are not the whole install ───
  //
  // This compared only `settings.json`, so with the hooks already in place it
  // reported "already installed — nothing would change" and returned *before
  // reaching the command files*. A missing or outdated command then had no way
  // to be repaired: re-running install, the obvious fix, confirmed there was
  // nothing to do. It only escaped notice because `describeChange` also lists
  // untouched keys, which kept the list non-empty by accident.
  const wanted: [string, string, string][] = [
    [commandFilePath(home), '/agentsensei:now', commandFileBody(repoRoot())],
    [fixCommandFilePath(home), '/agentsensei:fix', fixCommandBody(repoRoot())],
    [
      generateReportCommandFilePath(home),
      '/agentsensei:generate-report',
      generateReportCommandBody(repoRoot()),
    ],
  ];
  const commandLines: string[] = [];
  let commandsDiffer = false;
  for (const [p_, name, body] of wanted) {
    let state: string;
    if (!existsSync(p_)) {
      state = 'command (new)    ';
      commandsDiffer = true;
    } else if (readFileSync(p_, 'utf8') !== body) {
      // Content, not just presence: a body we have since reworded is stale, and
      // "exists" would hide that.
      state = 'command (update) ';
      commandsDiffer = true;
    } else {
      state = 'command (current)';
    }
    commandLines.push(`  ${state} ${name.padEnd(28)} ${p_}`);
  }

  console.log(`settings: ${path}\n`);
  if (change.length === 0 && !commandsDiffer) {
    console.log('already installed — nothing would change.');
    return 0;
  }
  console.log('this would change:');
  for (const l of change) console.log(l);
  for (const l of commandLines) console.log(l);
  for (const old of legacyCommandFiles(home)) {
    if (existsSync(old)) console.log(`  command (remove)  ${'un-namespaced'.padEnd(17)} ${old}`);
  }

  if (a.flags['apply'] !== true) {
    console.log('\nnothing written. re-run with --apply to write it,');
    console.log('or --print-only for the fragments to merge in by hand.');
    console.log('`agentsensei uninstall --apply` reverses exactly this.');
    return 0;
  }

  // **Timestamped, and never overwritten.** A fixed name meant the second
  // install clobbered the backup with an already-installed state, so the one
  // file meant to restore someone to pristine quietly stopped being able to.
  // Found by diffing a round-trip against it.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = `${path}.agentsensei-backup.${stamp}`;
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

  // A new file in their directory rather than an edit to one of theirs, so the
  // risk is lower — but it is still their directory, and `uninstall` removes it.
  try {
    mkdirSync(commandDir(home), { recursive: true });
    writeFileSync(commandFilePath(home), commandFileBody(repoRoot()));
    writeFileSync(fixCommandFilePath(home), fixCommandBody(repoRoot()));
    writeFileSync(generateReportCommandFilePath(home), generateReportCommandBody(repoRoot()));
    // The flat files an earlier version wrote, which would otherwise linger as
    // a second, un-namespaced `/agentsensei`.
    for (const old of legacyCommandFiles(home)) rmSync(old, { force: true });
  } catch {
    console.error(`could not write the command files — the slash commands will be missing.`);
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
 * One evidence-backed change to try.
 *
 * Reads the stored standing rather than computing, so it is instant and agrees
 * with what the session-start report said.
 */
function cmdFix(a: Argv): number {
  const { config } = configFromFlags(a);
  const s = readStanding(config.archive);
  if (s === undefined) {
    console.log('no standing yet — run `standing --refresh`, or open a new session.');
    return 0;
  }
  console.log(renderFix(recommend(s), config.preset, config.mute));
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

  const block = reportBlock(s, detailLine(repoRoot(), homedir()));
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
  const cmdFiles = [...ourCommandFiles(home), ...legacyCommandFiles(home)].filter(
    (f) => existsSync(f),
  );
  if (change.length === 0 && cmdFiles.length === 0) {
    console.log('nothing of ours is installed.');
    return 0;
  }
  for (const f of cmdFiles) console.log(`  remove  ${f}`);
  console.log('this would change:');
  for (const l of change) console.log(l);
  for (const [p_, name] of [
    [commandFilePath(home), '/agentsensei:now'],
    [fixCommandFilePath(home), '/agentsensei:fix'],
    [generateReportCommandFilePath(home), '/agentsensei:generate-report'],
  ] as const) {
    console.log(`  ${existsSync(p_) ? 'command (exists)' : 'command (new)   '}  ${name.padEnd(17)} ${p_}`);
  }
  for (const old of legacyCommandFiles(home)) {
    if (existsSync(old)) console.log(`  command (remove)  ${'un-namespaced'.padEnd(17)} ${old}`);
  }

  if (a.flags['apply'] !== true) {
    console.log('\nnothing written. re-run with --apply.');
    return 0;
  }
  writeFileSync(path, `${JSON.stringify(after, null, 2)}\n`);
  try {
    for (const f of ourCommandFiles(home)) rmSync(f, { force: true });
    for (const old of legacyCommandFiles(home)) rmSync(old, { force: true });
    // `rmdirSync`, not `rmSync`: it refuses a non-empty directory, which is
    // exactly the guard wanted. If someone put their own command in there, the
    // directory stays and so does their file.
    rmdirSync(commandDir(home));
  } catch {
    // Already gone, or never ours to remove.
  }
  console.log('\nremoved.');
  return 0;
}

/**
 * `report` — a range, what it covers, and what was found in it.
 *
 * Text by default, HTML with `--html`. Both render the **same** `ReportData`
 * from one session enumeration, so the two cannot disagree about which sessions
 * exist. See `src/gather.ts` for why that mattered.
 */
/**
 * `judge` — the one part of this tool that spends money, so the one part that
 * refuses to do anything without being told twice.
 *
 * `--dry-run` builds a real packet and prints what it would cost, calling
 * nothing. `--enable` shows the same and still writes nothing until `--apply`.
 * The shape is `install`'s, because the risk is the same shape: a background
 * process acting on someone's behalf while they are not looking.
 */
function cmdJudge(a: Argv): number {
  const { config } = configFromFlags(a);
  const state = readJudgeState(config.archive);
  const f = a.flags;

  if (f['disable'] === true) {
    if (f['apply'] !== true) {
      console.log('would disable the judge. re-run with --apply.');
      return 0;
    }
    state.settings.enabled = false;
    writeJudgeState(config.archive, state);
    console.log('judge disabled. nothing further will be sent.');
    return 0;
  }

  // A real packet from real sessions, so the number printed is the number it
  // would cost — not a guess from an average.
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

  const packetTokens = sessions.length === 0 ? 0 : Math.round((renderPacket(sessions).length / 4) * 1.9);

  console.log(`judge · ${state.settings.enabled ? 'enabled' : 'disabled'} · model ${state.settings.model}`);
  console.log('');
  console.log('  what one pass would send');
  console.log(`    ${sessions.length} session(s) · ~${packetTokens.toLocaleString()} tokens of packet`);
  // The invocation overhead is the dominant term and is not ours to shrink:
  // it is Claude Code loading its system prompt, tools and skills.
  console.log('    ~27,000 tokens of invocation overhead, whatever we send');
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
  console.log('');
  console.log('  Tokens, not money: what a token costs depends on your plan, your');
  console.log('  tier and the model, and on a subscription it is notional.');

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

  state.settings.enabled = true;
  writeJudgeState(config.archive, state);
  console.log('\n  judge enabled. it runs detached, after your turn ends.');
  console.log('  `agentsensei judge --disable --apply` stops it.');
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

  const detectors = detectorsFromConfig(config);
  if (detectors.length === 0) {
    console.error(`warning: preset "${config.preset}" selected no detectors`);
    return 0;
  }

  // `--session` accepts the short form every surface prints. An ambiguous
  // prefix is refused with its candidates rather than guessed at.
  let only: string | undefined;
  const wanted = f['session'];
  if (typeof wanted === 'string') {
    const hit = lookupSession(config.sources, wanted);
    if (!hit.ok) {
      console.error(sessionLookupError(wanted, hit));
      return 1;
    }
    only = hit.sessionId;
  }

  // ── When no range was asked for, do not impose one ───────────────────────
  //
  // The user chose "all sessions found" as the default for the HTML report, and
  // naming a session must never come back empty: `--session <id>` for a session
  // older than the implicit window answered "no sessions found in this range",
  // which is the worst possible reply to an explicit request.
  //
  // Plain-text `report` with no flags keeps its 7-day default — it is a
  // coverage report and that window is the point — but an explicit `--session`
  // overrides it there too.
  const asked = ['last', 'since', 'until'].some((k) => typeof f[k] === 'string');
  const wantsAll = !asked && (f['html'] === true || typeof f['out'] === 'string' || only !== undefined);

  const data = await gatherReport({
    sources: config.sources,
    detectors,
    ...(wantsAll ? {} : { range: range.range }),
    preset: config.preset,
    muted: config.mute,
    ...(only !== undefined ? { onlySessionId: only } : {}),
  });

  if (f['html'] === true || typeof f['out'] === 'string') {
    return writeHtmlReport(data, config.archive, f);
  }

  if (typeof f['project'] === 'string') {
    console.log(`  note: --project ${f['project']} is accepted but not yet applied`);
  }

  console.log(
    `report · ${data.range.from.toISOString().slice(0, 10)} → ` +
      `${data.range.to.toISOString().slice(0, 10)}`,
  );

  // Coverage from the sessions' own timestamps, not a catalog record of when we
  // first saw them — the mismatch that had `report` claiming a window was
  // uncovered while listing a session that spanned it.
  const covered = data.sessions
    .filter((s) => s.firstTs !== undefined && s.lastTs !== undefined)
    .map((s) => ({ from: new Date(s.firstTs as string), to: new Date(s.lastTs as string) }));
  console.log('\ncoverage');
  for (const l of describeCoverage(
    segmentByDepth(data.range, {
      covered,
      scanned: data.sessions.length > 0,
      hasPromptHistory: false,
    }),
  )) {
    console.log(l);
  }

  if (data.sessions.length === 0) {
    console.log('\nno sessions found in this range');
    return 0;
  }

  const total = data.sessions.reduce((n, s) => n + s.findings.length, 0);
  console.log(`\nfindings · ${data.sessions.length} session(s) analysed`);
  if (data.unreadable > 0) {
    console.log(`  ${data.unreadable} discovered session(s) could not be read`);
  }
  if (total === 0) {
    console.log('  none');
  } else {
    console.log('  by dimension');
    for (const dim of data.standing.dimensions) {
      console.log(`    ${dim.dimension.padEnd(20)} ${dim.occurrences} occurrence(s)`);
    }
  }
  if (config.mute.length > 0) console.log(`  muted: ${config.mute.join(', ')}`);
  return 0;
}

/** A session id that did not resolve, said in a way that can be acted on. */
function sessionLookupError(wanted: string, hit: SessionLookup & { ok: false }): string {
  switch (hit.reason) {
    case 'too-short':
      return `--session "${wanted}" is too short — give at least ${MIN_ID_PREFIX} characters`;
    case 'ambiguous':
      // Never pick one: analysing somebody else's session under an
      // authoritative-looking header is the failure worth being noisy about.
      return [
        `--session "${wanted}" matches ${hit.candidates.length} sessions:`,
        ...hit.candidates.map((c) => `    ${c}`),
      ].join('\n');
    default:
      return `no session matching "${wanted}"`;
  }
}

/**
 * Write the HTML report, 0600, temp-then-rename.
 *
 * Into the archive by default rather than the working directory: the page
 * carries file paths, turn numbers and refusal reasons across every session in
 * range, and the working directory is usually a git repo where one `git add -A`
 * would publish it. `--out` is the deliberate way to put it somewhere shared.
 */
function writeHtmlReport(data: ReportData, archive: string, f: Argv['flags']): number {
  // `2026-10-20-1234.html` — sortable, and in **local** time. `toISOString` is
  // UTC, so a report written at 12:34 was being named `…-1934.html`, which
  // reads as a different report from the one you just asked for.
  const d = new Date();
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` +
    `-${p2(d.getHours())}${p2(d.getMinutes())}`;
  const dir = join(archive, 'reports');
  const path = typeof f['out'] === 'string' ? f['out'] : join(dir, `${stamp}.html`);

  const html = renderHtml(data);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, html, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    console.error(`could not write ${path}: ${String(err)}`);
    return 1;
  }

  const total = data.sessions.reduce((n, s) => n + s.findings.length, 0);
  console.log(
    `wrote ${path}\n` +
      `  ${data.sessions.length} session(s) · ${total} finding(s) · ` +
      `${(Buffer.byteLength(html) / 1024).toFixed(0)} KB · mode 0600`,
  );

  if (f['open'] === true) {
    // `execFile`, never a shell string: the path is interpolated and `--out`
    // takes it from the command line.
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      execFileSync(opener, [path], { stdio: 'ignore' });
      console.log(`  opened with ${opener}`);
    } catch {
      // The fallback has to carry the command, not just the bad news: the
      // caller asked to open it and would otherwise be left with neither a
      // window nor anything to copy.
      console.log(`  could not launch ${opener} — run:  ${opener} ${path}`);
    }
  } else {
    console.log(`  open it:  ${process.platform === 'darwin' ? 'open' : 'xdg-open'} ${path}`);
  }
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
    case 'fix':
      return cmdFix(a);
    case 'judge':
      return cmdJudge(a);
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
