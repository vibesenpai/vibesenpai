#!/usr/bin/env node
/**
 * CLI entry. The secondary surface — the harness is primary (see docs/surfaces.md).
 *
 * M0 scope: `archive`, `doctor`, `config`. Detectors arrive in M2a.
 */

import { homedir } from 'node:os';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig, type Layer } from './config.ts';
import { describeArchive, runArchive, SyncRootRefusal } from './archive.ts';

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
      // --source is repeatable
      if (key === 'source') {
        const prev = out.flags['source'];
        out.flags['source'] = Array.isArray(prev) ? [...prev, next] : [next];
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
    },
  });
}

const USAGE = `agentsensei — find the turns where you and your agent wasted effort

Usage
  agentsensei archive            preserve transcripts before the harness deletes them
  agentsensei doctor             harnesses, paths, retention warning
  agentsensei config             resolved values and which layer set each

Options
  --source <path>    transcript source (repeatable)
  --archive <path>   archive location
  --models <path>    model location
  --config <path>    config file

Not yet implemented (see PLAN.md): now, report, fix, explain, claude-md, eval.
`;

function cmdArchive(a: Argv): number {
  const { config } = configFromFlags(a);
  try {
    const s = runArchive({
      sources: config.sources,
      archive: config.archive,
      allowSyncRoot: a.flags['allow-sync-root'] === true,
    });
    const changed = s.added + s.appended;
    console.log(
      `scanned ${s.scanned} transcript${s.scanned === 1 ? '' : 's'} · ` +
        `${s.added} new, ${s.appended} appended, ${s.unchanged} unchanged` +
        (s.reset > 0 ? `, ${s.reset} re-archived` : ''),
    );
    console.log(`read ${fmtBytes(s.bytesRead)}${changed === 0 ? ' (nothing new)' : ''}`);
    const d = describeArchive(config.archive);
    console.log(`archive · ${d.sessions} sessions · ${fmtBytes(d.bytes)} · ${config.archive}`);
    for (const sk of s.skipped) console.error(`skipped ${sk.path}: ${sk.reason}`);
    return 0;
  } catch (err) {
    if (err instanceof SyncRootRefusal) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
}

function cmdConfig(a: Argv): number {
  const { config, provenance } = configFromFlags(a);
  const show = (k: string, v: string, l: Layer): void =>
    console.log(`  ${k.padEnd(9)} ${v}  (${l})`);
  console.log('resolved config');
  show('sources', config.sources.join(', '), provenance.sources);
  show('archive', config.archive, provenance.archive);
  show('models', config.models, provenance.models);
  console.log(
    `  ${'config'.padEnd(9)} ${config.configFile ?? '(none)'}` +
      `  (${config.configFile && existsSync(config.configFile) ? 'present' : 'absent'})`,
  );
  return 0;
}

/** Read `cleanupPeriodDays` without ever writing the file. We report; we never fix. */
function retentionStatus(home: string): string[] {
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
    lines.push('  retention  cleanupPeriodDays not set → Claude Code default of 30 days applies');
    lines.push('             transcripts older than 30 days are deleted at the next cleanup');
    lines.push('             to keep the raw files longer, set it yourself in ~/.claude/settings.json');
    lines.push("             agentsensei's own archive is never cleaned");
  } else {
    lines.push(`  retention  cleanupPeriodDays = ${configured}`);
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
      if (statSync(s).isDirectory()) {
        const { sessions } = { sessions: 0 };
        void sessions;
        detail = 'present';
      }
    } catch {
      /* not present */
    }
    console.log(`  source     ${s}  (${detail})`);
  }

  const d = describeArchive(config.archive);
  console.log(`  archive    ${config.archive}`);
  console.log(`             ${d.sessions} sessions · ${fmtBytes(d.bytes)}`);

  let mode = 'absent';
  try {
    mode = (statSync(config.archive).mode & 0o777).toString(8);
  } catch {
    /* absent */
  }
  console.log(`             permissions ${mode}${mode === '700' || mode === 'absent' ? '' : '  ⚠ expected 700'}`);
  console.log(`  models     ${config.models}  (not installed)`);
  console.log('  network    no network calls during analysis');
  console.log('             the only network access is the opt-in model download, which is');
  console.log('             setup rather than analysis — hooks can never trigger it');
  console.log('');
  for (const l of retentionStatus(home)) console.log(l);
  return 0;
}

export function main(argv = process.argv.slice(2)): number {
  const a = parseArgv(argv);
  const cmd = a._[0];
  switch (cmd) {
    case 'archive':
      return cmdArchive(a);
    case 'doctor':
      return cmdDoctor(a);
    case 'config':
      return cmdConfig(a);
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
  process.exit(main());
}
