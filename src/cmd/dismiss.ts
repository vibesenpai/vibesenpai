/** `dismiss`: set findings aside, or bring them back. */

import { dim } from '../style.ts';
import { type Config } from '../config.ts';
import { resolveCurrentSession } from '../read.ts';
import { openStore, putDismissals, readDismissals, removeDismissals, transact, type Db, type DismissalRow, type DismissReason } from '../store.ts';
import { candidateLines, candidates, dismissalsFor, dismissedFrom, renderCandidates, resolve, shortIds } from '../dismiss.ts';
import { isFresh, readStanding } from '../standing.ts';
import { runAndWait } from '../spawn.ts';
import { plural } from '../format.ts';
import { type Argv, configFromFlags } from './common.ts';

/**
 * Set findings aside, or take it back. Nothing here deletes a finding: see `src/dismiss.ts`.
 *
 * ```
 *   dismiss --list           what can be dismissed, with short ids
 *   dismiss <id>… [--wrong]  dismiss those; --wrong records a false positive
 *   dismiss --all            clear everything currently shown
 *   dismiss --undo <id>…     restore; --undo --all restores everything
 *   dismiss --dismissed      what is dismissed now
 * ```
 *
 * The standing is recomputed in the foreground after a write, because the next session start reads it.
 */
export function cmdDismiss(a: Argv): number {
  const { config } = configFromFlags(a);
  const f = a.flags;
  // Ids arrive as positionals or as a flag's value (`--undo f3a91c`).
  const ids = [
    ...a._.slice(1),
    ...['wrong', 'undo', 'all'].flatMap((k) => (typeof f[k] === 'string' ? [f[k] as string] : [])),
  ];

  let db: Db;
  try {
    db = openStore(config.archive);
  } catch {
    console.error('the store could not be opened — see `vibesenpai doctor`.');
    return 1;
  }
  try {
    const rows = readDismissals(db);
    const current = resolveCurrentSession(config.sources, {})?.sessionId;

    if (f['dismissed'] === true) {
      process.stdout.write(renderDismissed(db, rows));
      return 0;
    }

    if (f['undo'] !== undefined) {
      const all = f['all'] !== undefined || ids.includes('all');
      const keys = all
        ? rows.map((r) => r.key)
        : (() => {
            const r = resolve(rows, (x) => x.key, ids);
            reportUnresolved(r);
            return r.found.map((x) => x.key);
          })();
      const n = transact(db, () => removeDismissals(db, keys));
      db.close();
      refreshStanding(config);
      console.log(`  Restored ${plural(n, 'dismissal')}.`);
      return n === 0 && keys.length > 0 ? 1 : 0;
    }

    if (f['list'] === true || (ids.length === 0 && f['all'] === undefined)) {
      // Refresh first so the current session's findings are listed.
      if (!isFresh(readStanding(config.archive))) {
        db.close();
        refreshStanding(config);
        db = openStore(config.archive);
      }
      const cs = candidates(db, dismissedFrom(readDismissals(db)));
      process.stdout.write(
        renderCandidates(cs, {
          ...(current === undefined ? {} : { currentSessionId: current }),
          dismissedBefore: rows.length,
        }),
      );
      return 0;
    }

    const cs = candidates(db, dismissedFrom(rows));
    const at = new Date().toISOString();
    const clearing = f['all'] !== undefined || ids.includes('all');
    const reason: DismissReason = clearing ? 'cleared' : f['wrong'] !== undefined ? 'wrong' : 'noise';
    const chosen = clearing
      ? cs
      : (() => {
          const r = resolve(cs, (c) => c.key, ids);
          reportUnresolved(r);
          return r.found;
        })();
    if (chosen.length === 0) {
      console.log(clearing ? '  Nothing to clear.' : '  Nothing dismissed.');
      return clearing ? 0 : 1;
    }
    transact(db, () => putDismissals(db, chosen.flatMap((c) => dismissalsFor(c, reason, at))));
    db.close();
    refreshStanding(config);

    const short = shortIds(chosen.map((c) => c.key));
    const why = reason === 'wrong' ? ' as wrong' : '';
    console.log(`  ${clearing ? 'Cleared' : 'Dismissed'} ${plural(chosen.length, 'finding')}${why}.`);
    if (!clearing) {
      for (const c of chosen) {
        console.log(`    ${candidateLines(c, short.get(c.key) ?? c.key, current)[0]}`);
      }
    }
    console.log('');
    console.log(
      dim(
        clearing
          ? '  Hidden from insights, fix and new sessions. New findings will still show.'
          : '  Hidden from insights, fix and new sessions.',
      ),
    );
    console.log(dim(clearing ? "  Restore all on the pane's Health tab brings them back." : '  Undo in the pane brings them back.'));
    return 0;
  } finally {
    try {
      db.close();
    } catch {
      // Already closed before the refresh.
    }
  }
}

/** Typed ids that matched nothing, or more than one thing. Said, never skipped. */
export function reportUnresolved(r: { unknown: string[]; ambiguous: string[] }): void {
  for (const u of r.unknown) console.error(`  no finding matches "${u}"`);
  for (const u of r.ambiguous) console.error(`  "${u}" matches more than one finding — type more of it`);
}

/** What is dismissed, labelled from the findings it hides. */
function renderDismissed(db: Db, rows: DismissalRow[]): string {
  if (rows.length === 0) return '  Nothing is dismissed.\n';
  const known = new Map(candidates(db, dismissedFrom([])).map((c) => [c.key, c]));
  const cleared = rows.filter((r) => r.reason === 'cleared');
  const named = rows.filter((r) => r.reason !== 'cleared');
  const short = shortIds(named.map((r) => r.key));
  const lines: string[] = [];
  for (const r of named) {
    const c = known.get(r.key);
    const label = c === undefined ? r.dimension.replace(/_/g, ' ') : (candidateLines(c, '').at(0) ?? '').trim();
    lines.push(`    ${short.get(r.key)}  ${r.reason === 'wrong' ? 'wrong ' : 'hidden'}  ${label}`);
  }
  if (cleared.length > 0) {
    // Local day, as everywhere else a person reads a date. The stored time is UTC.
    const last = cleared.map((r) => r.at).sort().at(-1);
    const day = last === undefined ? undefined
      : new Date(last).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    lines.push(`    ${plural(cleared.length, 'finding')} cleared${day === undefined ? '' : ` on ${day}`}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Recompute the standing now, quietly; a failure leaves the old one in place.
 * Config is passed via env, or the child would recompute the default archive.
 */
export function refreshStanding(config: Config): void {
  try {
    // A dismissal changes no fix, so the finding fixes are not rebuilt here.
    runAndWait('compute-standing.ts', ['--force', '--skip-fixes'], {
      env: {
        ...process.env,
        VIBESENPAI_ARCHIVE: config.archive,
        VIBESENPAI_SOURCES: config.sources.join(','),
        VIBESENPAI_PRESET: config.preset,
        VIBESENPAI_MUTE: config.mute.join(','),
      },
    });
  } catch {
    // Principle Zero: the dismissal is recorded; the next background pass applies it.
  }
}
