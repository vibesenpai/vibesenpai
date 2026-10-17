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
import { describeCatalog, readCatalog, runScan } from './catalog.ts';
import { parse, registry } from './parsers/index.ts';

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
  agentsensei scan               read new transcript data (copies nothing)
  agentsensei doctor             harnesses, paths, parser coverage
  agentsensei config             resolved values and which layer set each

Options
  --source <path>    transcript source (repeatable)
  --archive <path>   store location (catalog + findings)
  --models <path>    model location
  --config <path>    config file

Not yet implemented (see PLAN.md): now, report, fix, explain, claude-md, eval.
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

export function main(argv = process.argv.slice(2)): number {
  const a = parseArgv(argv);
  const cmd = a._[0];
  switch (cmd) {
    case 'scan':
      return cmdScan(a);
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
  try {
    process.exit(main());
  } catch (err) {
    // A bad flag is a user error, not a crash. No stack trace.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
