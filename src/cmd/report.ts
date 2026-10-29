/** `report`: a date range as text, or as an HTML file. */

import { homedir } from 'node:os';
import { bold, dim } from '../style.ts';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { lookupSession, MIN_ID_PREFIX, type SessionLookup, sessionSizes } from '../read.ts';
import { gatherReport, type ReportData } from '../gather.ts';
import { findingsFor, readJudgeState } from '../judge/state.ts';
import { pendingWork, progressLine } from '../judge/schedule.ts';
import { JUDGE_STALE_MS, jobsHealth } from '../jobs.ts';
import { renderHtml } from '../html.ts';
import { describeCoverage, resolveRange, segmentByDepth } from '../range.ts';
import { leadSegments } from '../render.ts';
import { currentRun, measuredCallMs, openStore, readLabels, withStore } from '../store.ts';
import { readDismissed } from '../dismiss.ts';
import { nextRung } from '../session-block.ts';
import { plural } from '../format.ts';
import { writeAtomic } from '../files.ts';
import { type Argv, configFromFlags, detectorsFromConfig } from './common.ts';

export async function cmdReport(a: Argv): Promise<number> {
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

  // Accepts the short id; an ambiguous prefix is refused with its candidates.
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

  // No implicit range for HTML or for `--session`: naming a session must never come back empty.
  // Plain-text `report` keeps its 7-day default.
  const asked = ['last', 'since', 'until'].some((k) => typeof f[k] === 'string');
  const wantsAll =
    !asked && (f['html'] === true || f['json'] === true || typeof f['out'] === 'string' || only !== undefined);

  // The judge's findings, so `report` sees the model tier too.
  const judgeState = readJudgeState(config.archive);
  const data = await gatherReport({
    sources: config.sources,
    detectors,
    ...(wantsAll ? {} : { range: range.range }),
    preset: config.preset,
    muted: config.mute,
    ...(only !== undefined ? { onlySessionId: only } : {}),
    judgedFor: (id) => findingsFor(judgeState, id),
    dismissed: readDismissed(config.archive),
  });

  if (f['json'] === true) {
    // For the insights pane: the report's data plus how much is read and how the jobs are doing.
    const sizes = sessionSizes(config.sources);
    const w = pendingWork(judgeState, sizes);
    const labels = Object.fromEntries((withStore(config.archive, readLabels) ?? []).map((l) => [l.key, l.verdict]));
    const out = { ...data, archive: config.archive, read: w.judged + w.behind, total: sizes.length, health: jobsHealth(config.archive), labels };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return 0;
  }
  if (f['html'] === true || typeof f['out'] === 'string') {
    return writeHtmlReport(data, config.archive, f, config.sources);
  }

  // Same lead as every other surface.
  const reportRule = data.sessions.reduce(
    (n, sv) => n + sv.findings.reduce((m, f) => m + f.occurrences, 0),
    0,
  );
  const reportJudged = data.sessions.reduce((n, sv) => n + sv.judged.length, 0);
  const reportLead = leadSegments({
    ruleCount: reportRule,
    judgedCount: reportJudged,
    total: reportRule + reportJudged,
    wasted: data.sessions.reduce((n, sv) => n + sv.cost.written, 0),
    editCount: data.standing.edits,
  });
  console.log(
    reportLead.figure === undefined
      ? reportLead.rest
      : `${bold(reportLead.figure)}${reportLead.rest}`,
  );
  console.log(
    dim(
      `  report · ${data.range.from.toISOString().slice(0, 10)} → ` +
        `${data.range.to.toISOString().slice(0, 10)}`,
    ),
  );

  // Coverage from the sessions' own timestamps, not from when we first saw them.
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

  // Both tiers, matching what the page counts.
  const total = data.sessions.reduce(
    (n, s) => n + s.findings.reduce((m, f) => m + f.occurrences, 0) + s.judged.length,
    0,
  );
  console.log(`\nfindings · ${data.sessions.length} session(s) analysed`);
  if (data.unreadable > 0) {
    console.log(`  ${data.unreadable} discovered session(s) could not be read`);
  }
  if (total === 0) {
    console.log('  none');
  } else {
    // Width from the data, not a constant.
    const names = [
      ...data.standing.dimensions.map((d) => d.dimension),
      ...data.sessions.flatMap((s) => s.judged.map((j) => j.dimension)),
    ];
    const w = Math.max(1, ...names.map((n) => n.length));
    if (data.standing.dimensions.length > 0) {
      console.log('  by dimension');
      for (const dim of data.standing.dimensions) {
        console.log(`    ${dim.dimension.padEnd(w)}  ${dim.occurrences} occurrence(s)`);
      }
    }
    // The model tier: `standing.dimensions` never contains these.
    const byDimension = new Map<string, number>();
    for (const s of data.sessions) {
      for (const j of s.judged) byDimension.set(j.dimension, (byDimension.get(j.dimension) ?? 0) + 1);
    }
    if (byDimension.size > 0) {
      console.log('  flagged by a model');
      for (const [dim, n] of [...byDimension].sort((a, b) => b[1] - a[1])) {
        console.log(`    ${dim.padEnd(w)}  ${n} finding(s)`);
      }
    }
  }
  if (config.mute.length > 0) console.log(`  muted: ${config.mute.join(', ')}`);
  return 0;
}

/** A session id that did not resolve, said in a way that can be acted on. */
export function sessionLookupError(wanted: string, hit: SessionLookup & { ok: false }): string {
  switch (hit.reason) {
    case 'too-short':
      return `--session "${wanted}" is too short — give at least ${MIN_ID_PREFIX} characters`;
    case 'ambiguous':
      // Never pick one: guessing would analyse the wrong session under an authoritative header.
      return [
        `--session "${wanted}" matches ${hit.candidates.length} sessions:`,
        ...hit.candidates.map((c) => `    ${c}`),
      ].join('\n');
    default:
      return `no session matching "${wanted}"`;
  }
}

/**
 * Write the HTML report, 0600, temp-then-rename. Into the archive by default, not the working
 * directory, where `git add -A` could publish it.
 */
export function writeHtmlReport(
  data: ReportData,
  archive: string,
  f: Argv['flags'],
  sources: string[],
): number {
  // `2026-10-20-1234.html`: sortable, in local time (not `toISOString` UTC).
  const d = new Date();
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` +
    `-${p2(d.getHours())}${p2(d.getMinutes())}`;
  const dir = join(archive, 'reports');
  const path = typeof f['out'] === 'string' ? f['out'] : join(dir, `${stamp}.html`);

  const html = renderHtml(data);
  try {
    writeAtomic(path, html);
  } catch (err) {
    console.error(`could not write ${path}: ${String(err)}`);
    return 1;
  }

  // Both tiers, matching what the page counts.
  const total = data.sessions.reduce(
    (n, s) => n + s.findings.reduce((m, f) => m + f.occurrences, 0) + s.judged.length,
    0,
  );
  // Opening is opt-in (`--open`): the output may be piped.
  // `execFile`, never a shell string, because the path is interpolated.
  const wantsOpen = f['open'] === true;
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  let opened = false;
  if (wantsOpen) {
    try {
      execFileSync(opener, [path], { stdio: 'ignore' });
      opened = true;
    } catch {
      opened = false;
    }
  }

  // The home directory is most of the length and none of the information.
  const shown = path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path;
  const n = data.sessions.length;
  console.log('');
  console.log(
    `  ${plural(n, 'session')} · ${plural(total, 'finding')}` +
      (opened ? ' — opened in your browser' : ''),
  );
  console.log(`  ${dim(shown)}`);

  // Say how many sessions could not be read, not only how many were used.
  try {
    const db = openStore(archive);
    let line = '';
    try {
      const run = currentRun(db, JUDGE_STALE_MS);
      const measured = measuredCallMs(db);
      const { unread } = pendingWork(readJudgeState(archive), sessionSizes(sources));
      line = progressLine({
        unread,
        ...(run === undefined ? {} : { running: run }),
        ...(measured === undefined ? {} : { callMs: measured }),
      });
    } finally {
      db.close();
    }
    if (line !== '') console.log(`  ${dim(line)}`);
  } catch {
    // A store that will not open is not a reason to withhold the report.
  }
  if (wantsOpen && !opened) console.log(`  ${dim(`could not launch ${opener} — run:  ${opener} ${shown}`)}`);
  console.log('');
  console.log(`  ${dim(nextRung('report'))}`);
  console.log('');
  return 0;
}
