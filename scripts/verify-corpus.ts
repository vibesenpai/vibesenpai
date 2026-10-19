/**
 * Parser validation against public transcripts. Run via scripts/verify-corpus.sh
 * — it fetches the pinned corpora first. See that script for what this caught.
 *
 * Two things are asserted here rather than eyeballed:
 *
 *   1. **No leaks.** Redaction must be a *no-op* on everything we emit. If
 *      re-redacting any Event field changes it, that field reached us by a path
 *      that skipped the redactor — which is exactly how `filePath` and `command`
 *      carried 347 raw home paths while `summarise()` looked clean.
 *   2. **The baseline holds.** Counts are compared against scripts/corpus.json.
 *      Drift fails loudly instead of being read past.
 *
 * Both exit non-zero, so this is a gate and not a report.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { parse } from '../src/parsers/index.ts';
import { redact } from '../src/redact.ts';
import { buildSkeletons, render } from '../src/skeleton.ts';
import type { Event } from '../src/types.ts';

const root = process.env.AGENTSENSEI_CORPUS ?? '/tmp/agentsensei-corpus';
const manifest = JSON.parse(
  readFileSync(join(import.meta.dirname, 'corpus.json'), 'utf8'),
) as { baseline: Record<string, number> };

const files = execSync(`find ${root} -name '*.jsonl' -size +0`, { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);

let totalEvents = 0, totalMalformed = 0, totalAbandoned = 0, parsedFiles = 0, emptyFiles = 0;
const unknownTypes: Record<string, number> = {};
const versions: Record<string, number> = {};
const matches: Record<string, number> = {};
const turnTypes: Record<string, number> = {};
let sidechainEvents = 0;
const failures: string[] = [];

/**
 * Skeleton compression, measured per session rather than in aggregate.
 *
 * The aggregate ratio over this corpus is 1.28%, which is a flattering number:
 * it is dominated by a handful of very large transcripts. Per file the median is
 * 5.2% and 69 of 223 files exceed the 5–10% target — all of them tiny fixtures
 * where there is simply no bulk to strip. The worst is a 0.6 KB file holding a
 * single record, at 34.9%.
 *
 * So the target is asserted where it means something: a session of >= 20 events.
 * At that size 0 of 37 files exceed 10% (median 1.6%, max 6.8%). Reporting the
 * aggregate alone would have hidden the shape entirely.
 *
 * The denominator is whole raw JSONL bytes, which is the generous reading — the
 * file also holds records the skeleton never claimed to cover. Stated rather
 * than quietly chosen, and the size gate is what keeps it honest.
 */
const REAL_SESSION_EVENTS = 20;
let skeletonWindows = 0, sidechainWindows = 0, elidedWindows = 0;
let rawBytes = 0, skeletonBytes = 0;
const realRatios: number[] = [];

/**
 * Fields are checked by enumeration rather than by a hand-written list, so a new
 * string field added to `Event` is covered the day it appears. A list would have
 * to be remembered, and the leak we actually shipped came from forgetting one.
 */
const leaks: { file: string; field: string; before: string; after: string }[] = [];

function checkEvent(e: Event, file: string): void {
  for (const [field, value] of Object.entries(e)) {
    if (typeof value !== 'string') continue;
    const after = redact(value).text;
    if (after !== value) leaks.push({ file, field, before: value, after });
  }
}

for (const f of files) {
  let r;
  try {
    r = parse(f, readFileSync(f, 'utf8'), f.split('/').pop()!.replace('.jsonl', ''));
  } catch (err) {
    failures.push(`${f.replace(`${root}/`, '')}: ${err instanceof Error ? err.message : err}`);
    continue;
  }
  parsedFiles++;
  if (r.events.length === 0) emptyFiles++;
  totalEvents += r.events.length;
  totalMalformed += r.malformed;
  totalAbandoned += r.abandoned;
  for (const [k, v] of Object.entries(r.unknown)) unknownTypes[k] = (unknownTypes[k] ?? 0) + v;
  const ver = r.provenance.version ?? '(none)';
  versions[ver] = (versions[ver] ?? 0) + 1;
  matches[r.provenance.match] = (matches[r.provenance.match] ?? 0) + 1;
  for (const e of r.events) {
    turnTypes[e.turnType] = (turnTypes[e.turnType] ?? 0) + 1;
    if (e.isSidechain) sidechainEvents++;
    checkEvent(e, f.replace(`${root}/`, ''));
  }

  if (r.events.length > 0) {
    const sks = buildSkeletons('corpus', r.events);
    const rendered = sks.map(render).join('\n');
    skeletonWindows += sks.length;
    sidechainWindows += sks.filter((s) => s.sidechainId !== undefined).length;
    elidedWindows += sks.filter((s) => s.elided !== undefined).length;
    const raw = Buffer.byteLength(readFileSync(f, 'utf8'));
    rawBytes += raw;
    skeletonBytes += Buffer.byteLength(rendered);
    // Skeleton lines are emitted text, so they must satisfy the same no-op
    // invariant as Event fields — the rendering is a second path to a leak.
    if (redact(rendered).text !== rendered) {
      leaks.push({ file: f.replace(`${root}/`, ''), field: 'skeleton:render', before: rendered.slice(0, 200), after: '' });
    }
    if (r.events.length >= REAL_SESSION_EVENTS) realRatios.push(Buffer.byteLength(rendered) / raw);
  }
}

console.log(`files: ${files.length}  parsed: ${parsedFiles}  threw: ${failures.length}  produced 0 events: ${emptyFiles}`);
console.log(`events: ${totalEvents}   malformed lines: ${totalMalformed}   abandoned: ${totalAbandoned}`);
console.log(`\nversions seen (${Object.keys(versions).length}):`);
for (const [v, n] of Object.entries(versions).sort()) console.log(`  ${v.padEnd(12)} ${n} files`);
console.log(`\nparser match levels:`, matches);
console.log(`\nturn types:`, turnTypes);
console.log(`\nSIDECHAIN events: ${sidechainEvents}`);
console.log(`\nunknown types:`, Object.keys(unknownTypes).length ? unknownTypes : '(none)');
if (failures.length) { console.log('\nFAILURES:'); for (const f of failures.slice(0, 8)) console.log('  ✗', f); }

// ── Leak gate ───────────────────────────────────────────────────────────────
console.log(`\nleak check: ${totalEvents} events, ${leaks.length} field(s) redaction would still change`);
if (leaks.length) {
  const byField: Record<string, number> = {};
  for (const l of leaks) byField[l.field] = (byField[l.field] ?? 0) + 1;
  console.log('  by field:', byField);
  for (const l of leaks.slice(0, 5)) {
    console.log(`  ✗ ${l.field} in ${l.file}`);
    console.log(`      emitted: ${l.before.slice(0, 110)}`);
    console.log(`      should be: ${l.after.slice(0, 110)}`);
  }
}

// ── Skeleton compression ────────────────────────────────────────────────────
realRatios.sort((a, b) => a - b);
const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;
const overTarget = realRatios.filter((r) => r > 0.10).length;
console.log(`\nskeleton: ${skeletonWindows} windows (${sidechainWindows} sidechain), ${elidedWindows} elided`);
console.log(`  aggregate ${pct(skeletonBytes / rawBytes)} — flattering; dominated by a few large files`);
if (realRatios.length > 0) {
  console.log(
    `  sessions >= ${REAL_SESSION_EVENTS} events (n=${realRatios.length}): ` +
      `median ${pct(realRatios[Math.floor(realRatios.length / 2)]!)}, ` +
      `max ${pct(realRatios.at(-1)!)}, over 10%: ${overTarget}`,
  );
}

// ── Baseline gate ───────────────────────────────────────────────────────────
const actual: Record<string, number> = {
  files: files.length,
  parsed: parsedFiles,
  threw: failures.length,
  events: totalEvents,
  malformed: totalMalformed,
  abandoned: totalAbandoned,
  versions: Object.keys(versions).length,
  sidechainEvents,
  leaks: leaks.length,
  skeletonWindows,
  skeletonsOverTarget: overTarget,
};

const drift = Object.entries(manifest.baseline)
  .filter(([k, want]) => actual[k] !== want)
  .map(([k, want]) => `  ${k}: expected ${want}, got ${actual[k]}`);

if (drift.length) {
  console.log('\nBASELINE DRIFT:');
  for (const d of drift) console.log(d);
  console.log('\nThe corpora are pinned, so this means the parser changed behaviour.');
  console.log('If the change is intended, update the baseline in scripts/corpus.json.');
  process.exit(1);
}

console.log('\nbaseline holds — all counts match scripts/corpus.json');
