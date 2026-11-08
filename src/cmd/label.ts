/** `label`: record whether a finding was a real mistake, just a suggestion, or wrong. The gold set for judge accuracy. */

import { candidates, dismissalsFor, emptyDismissed, resolve } from '../dismiss.ts';
import { openStore, putDismissals, putLabel, readLabels, removeDismissals, removeLabel, transact, type Verdict } from '../store.ts';
import { type Argv, configFromFlags } from './common.ts';
import { refreshStanding, reportUnresolved } from './dismiss.ts';

const VERDICTS: readonly Verdict[] = ['mistake', 'suggestion', 'wrong'];

/**
 * ```
 *   label <id> mistake|suggestion|wrong   record a verdict; suggestion and wrong also dismiss it
 *   label <id> --undo                     take the verdict back, and the dismissal it made
 *   label --list                          every verdict, as JSON
 * ```
 */
export function cmdLabel(a: Argv): number {
  const { config } = configFromFlags(a);
  const [, id, verdict] = a._;
  const db = openStore(config.archive);
  try {
    if (a.flags['list'] === true) {
      process.stdout.write(`${JSON.stringify(readLabels(db))}\n`);
      return 0;
    }
    if (id !== undefined && a.flags['undo'] === true) {
      const r = resolve(candidates(db, emptyDismissed()), (c) => c.key, [id]);
      reportUnresolved(r);
      const c = r.found[0];
      if (c === undefined) return 1;
      const had = readLabels(db).find((l) => l.key === c.key);
      transact(db, () => {
        removeLabel(db, c.key);
        if (had !== undefined && had.verdict !== 'mistake') removeDismissals(db, dismissalsFor(c, had.verdict, had.at).map((d) => d.key));
      });
      console.log(`  Took back the answer on ${c.dimension.replace(/_/g, ' ')}.`);
      if (had !== undefined && had.verdict !== 'mistake') refreshStanding(config);
      return 0;
    }
    if (id === undefined || !VERDICTS.includes(verdict as Verdict)) {
      console.error('usage: vibesenpai label <id> mistake|suggestion|wrong');
      return 1;
    }
    // Resolve among every finding, dismissed or not: labelling one that is already hidden is allowed.
    const r = resolve(candidates(db, emptyDismissed()), (c) => c.key, [id]);
    reportUnresolved(r);
    const c = r.found[0];
    if (c === undefined) return 1;
    const at = new Date().toISOString();
    const v = verdict as Verdict;
    transact(db, () => {
      putLabel(db, { key: c.key, dimension: c.dimension, verdict: v, at });
      if (v !== 'mistake') putDismissals(db, dismissalsFor(c, v, at));
    });
    console.log(`  Labelled ${c.dimension.replace(/_/g, ' ')} as ${v === 'mistake' ? 'a real mistake' : v === 'suggestion' ? 'a suggestion' : 'wrong'}.`);
  } finally {
    db.close();
  }
  if (verdict !== 'mistake') refreshStanding(config);
  return 0;
}
