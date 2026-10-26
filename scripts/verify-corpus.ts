/**
 * Parser gate over the pinned public corpora (run via scripts/verify-corpus.sh). Exits non-zero on
 * a leak (re-redacting any emitted field changes it) or on count drift from scripts/corpus.json.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, basename, dirname } from 'node:path';
import { parse } from '../src/parsers/index.ts';
import { redact } from '../src/redact.ts';
import { buildSkeletons, renderSkeleton } from '../src/skeleton.ts';
import { runDetectors, detectorsFor, countDenominators } from '../src/detect/index.ts';
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
 * Skeleton compression per session. The 5-10% target is asserted only for sessions of >= 20
 * events; tiny fixtures have no bulk to strip. Denominator: whole raw JSONL bytes.
 */
const REAL_SESSION_EVENTS = 20;
let skeletonWindows = 0, sidechainWindows = 0, elidedWindows = 0;
let rawBytes = 0, skeletonBytes = 0;
const realRatios: number[] = [];

/** Detector results, kept in the gate so a behaviour change shows up as drift. */
const parsedSessions: { project: string; events: Event[] }[] = [];

/** Fields checked by enumeration, so a new string field on `Event` is covered automatically. */
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
    const rendered = sks.map(renderSkeleton).join('\n');
    skeletonWindows += sks.length;
    sidechainWindows += sks.filter((s) => s.sidechainId !== undefined).length;
    elidedWindows += sks.filter((s) => s.elided !== undefined).length;
    const raw = Buffer.byteLength(readFileSync(f, 'utf8'));
    rawBytes += raw;
    skeletonBytes += Buffer.byteLength(rendered);
    // Skeleton lines are emitted text: the same no-op redaction invariant applies.
    if (redact(rendered).text !== rendered) {
      leaks.push({ file: f.replace(`${root}/`, ''), field: 'skeleton:render', before: rendered.slice(0, 200), after: '' });
    }
    if (r.events.length >= REAL_SESSION_EVENTS) realRatios.push(Buffer.byteLength(rendered) / raw);
  }

  if (r.events.length > 0) {
    parsedSessions.push({ project: basename(dirname(f)), events: r.events });
  }
}

// Detectors
const detectors = detectorsFor('all');
const byDimension: Record<string, number> = {};
let detFindings = 0;
let detFailures = 0;
let editCount = 0;
let failedCallCount = 0;
let unclassifiedTouchCount = 0;
let outputTokens = 0;
let cacheCreationTokens = 0;

for (const s of parsedSessions) {
  const d = countDenominators(s.events);
  editCount += d.editCount;
  failedCallCount += d.failedCallCount;
  unclassifiedTouchCount += d.unclassifiedTouchCount;
  outputTokens += d.tokens.output;
  cacheCreationTokens += d.tokens.cacheCreation;

  const res = await runDetectors({
    events: s.events,
    session: { sessionId: 'corpus', project: s.project, live: false },
    now: 'corpus',
    detectors,
  });
  detFailures += Object.values(res.failures).reduce((a, b) => a + b, 0);
  for (const f of res.findings) {
    detFindings++;
    byDimension[f.dimension] = (byDimension[f.dimension] ?? 0) + 1;
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

// Leak gate
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

// Skeleton compression
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

console.log(`\ndetectors: ${detectors.length} run over ${parsedSessions.length} sessions`);
console.log(`  scopes: ${detectors.map((d) => `${d.dimension}=${d.scope}`).join('  ')}`);
console.log(`  findings ${detFindings} ${JSON.stringify(byDimension)} · detector failures ${detFailures}`);
console.log(
  `  edits ${editCount} · harness-declared failures ${failedCallCount} · ` +
    `unclassified touches ${unclassifiedTouchCount}`,
);
console.log(`  tokens: output ${outputTokens} · cache creation ${cacheCreationTokens}`);

// Baseline gate
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
  detectorFindings: detFindings,
  detectorFailures: detFailures,
  editCount,
  failedCallCount,
  unclassifiedTouchCount,
  outputTokens,
  cacheCreationTokens,
};

const drift = Object.entries(manifest.baseline)
  .filter(([k, want]) => actual[k] !== want)
  .map(([k, want]) => `  ${k}: expected ${want}, got ${actual[k]}`);

if (drift.length) {
  console.log('\nBASELINE DRIFT:');
  for (const d of drift) console.log(d);
  console.log('\nThe corpora are pinned, so the input did not change — the parser,');
  console.log('skeletonizer, redactor or a detector did. If the change is intended,');
  console.log('update the baseline in scripts/corpus.json and say why in the commit.');
  process.exit(1);
}

console.log('\nbaseline holds — all counts match scripts/corpus.json');
