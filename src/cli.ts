#!/usr/bin/env node
/** CLI entry: argv, help, and one function per command. The plugin's slash commands call it. */

import { realpathSync } from 'node:fs';

import { cmdConfig, cmdDoctor, cmdScan, cmdSkeleton, cmdStanding, cmdTick } from './cmd/admin.ts';
import { cmdInsights } from './cmd/insights.ts';
import { cmdFix } from './cmd/fix.ts';
import { cmdDismiss } from './cmd/dismiss.ts';
import { cmdLabel } from './cmd/label.ts';
import { cmdJudge } from './cmd/judge.ts';
import { cmdReport } from './cmd/report.ts';
import type { Argv } from './cmd/common.ts';

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
      // Repeatable flags are always arrays, even when given once.
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

const USAGE = `agentsensei — find out why your agents failed you

Usage
  agentsensei insights          the session you are in, read live
  agentsensei report            retrospective over a date range
  agentsensei fix               a recommendation, with its evidence
  agentsensei dismiss           set findings aside: --list, <id>… [--wrong], --all, --undo
  agentsensei label <id> <v>    mark a finding: mistake | suggestion | wrong (--list for all)
  agentsensei standing          what your history says
  agentsensei judge             the model pass: --status, --backlog, --enable, --disable
  agentsensei doctor            harnesses, paths, parser coverage
  agentsensei config            resolved values and which layer set each
  agentsensei scan              read new transcript data (copies nothing)
  agentsensei skeleton <id>     print a session's windows as evidence
  agentsensei tick              heal and run due background jobs (--judge to include the model pass)

Options
  --source <path>    transcript source (repeatable)
  --archive <path>   store location
  --config <path>    config file
  --preset <name>    core | standard | all   (default core)
  --mute <name>      silence a dimension (repeatable)

insights / skeleton
  --session <id>     which session (a unique prefix is enough)
  --live             read past the catalog offset, to the end of the file
  --skeleton         also dump the token-budget windows
  --window <n>       print only window n (1-based)

report
  --last <7d|4w|6m>  relative range (default 7d)
  --since <date>     YYYY-MM-DD, with --until
  --until <date>     YYYY-MM-DD
  --session <id>     one session only
  --html             write an HTML report; --open opens it, --out <path> picks the file
  --json             the report's data as JSON (what the insights pane reads)

judge
  --status           what has been read, what is left, what it cost
  --backlog          what a full pass would cost; sends nothing without --apply
  --dry-run          build a real packet and price it, calling nothing
  --enable / --disable [--apply]

standing
  --refresh          recompute from every transcript now, in the foreground
`;

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
    case 'insights':
      return cmdInsights(a);
    case 'report':
      return cmdReport(a);
    case 'standing':
      return cmdStanding(a);
    case 'fix':
      return cmdFix(a);
    case 'dismiss':
      return cmdDismiss(a);
    case 'judge':
      return cmdJudge(a);
    case 'tick':
      return cmdTick(a);
    case 'label':
      return cmdLabel(a);
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

/**
 * Was this file invoked directly? Compares resolved paths: npm installs the bin as a symlink,
 * so `import.meta.filename === argv[1]` never matches globally and the CLI silently does nothing.
 */
function invokedDirectly(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  if (import.meta.filename === argv1) return true;
  try {
    return import.meta.filename === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    process.exit(await main());
  } catch (err) {
    // A bad flag is a user error, not a crash. No stack trace.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
