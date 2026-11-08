/** `report`: a date range as text, or as an HTML file. */

import { homedir } from 'node:os';
import { bold, dim } from '../style.ts';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { lookupSession, MIN_ID_PREFIX, type SessionLookup, sessionSizes } from '../read.ts';
import { gatherReport, type ReportData } from '../gather.ts';
import { findingsFor, readJudgeState } from '../judge/state.ts';
import { estimateQueueSeconds, pendingWork, progressLine } from '../judge/schedule.ts';
import { JUDGE_STALE_MS, jobsHealth } from '../jobs.ts';
import { renderHtml } from '../html.ts';
import { describeCoverage, resolveRange, segmentByDepth } from '../range.ts';
import { leadSegments } from '../render.ts';
import { currentRun, measuredCallMs, measuredMsPerToken, openStore, sessionCosts, readFixApplied, readLabels, readRuleLoaded, readSpend, sessionSpans, spendSince, withStore, type Spend } from '../store.ts';
import { batchCost, catchUpFrom, eligible, todayLeft, waitingOnRequest } from '../judge/limits.ts';
import { applyPlan, type ApplyPlan } from '../fix.ts';
import { fixStates, type FixState, type OutcomeSession } from '../outcome.ts';
import { applyRequest, destination, projectKey } from '../harness/claude-code.ts';
import { applyRefusal, fixDisplay, whereLine } from '../harness/fix-display.ts';
import { findingPlan, KIND_WORDS, type FindingFix } from '../finding-fix.ts';
import { readFindingFixes } from '../fix-file.ts';
import type { JudgeState } from '../judge/state.ts';
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
    const fixes = fixesFor(data, judgeState, config.archive, projectKey(process.cwd()));
    const out = { ...data, archive: config.archive, read: w.judged + w.behind, total: sizes.length, health: jobsHealth(config.archive), labels, fixes, spend: spendFor(judgeState, config.archive, sizes), progress: progressFor(judgeState, config.archive, sizes), dismissed: (judgeState.dismissed ?? 0) + (data.standing.dismissed ?? 0) };
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
      console.log('  also flagged');
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

/** What the pane shows of a fix beyond its state: whose it is, its kind in words, and why it has no Apply. */
type FixMeta = { findingIds?: string[]; shared?: { findings: number; sessions: number }; kindLine?: string; whereLine?: string; shown?: string; refusal?: string };
type PaneFixOut = FixState & FixMeta & { destination: string; request: string };

/**
 * Every fix the pane can offer, each with its request text and whether it worked: each dimension's, and each
 * finding's own (D67), read from the standing pass. A finding's fix from another project is listed with no Apply.
 */
function fixesFor(data: ReportData, judge: JudgeState, archive: string, project: string): PaneFixOut[] {
  const plans = Object.values(data.recommendations).map(applyPlan).filter((p): p is ApplyPlan => p !== undefined);
  const own = ownFixes(archive, project);
  plans.push(...own.plans);
  const stored = withStore(archive, (db) => ({ applied: readFixApplied(db), loaded: readRuleLoaded(db), spans: sessionSpans(db) }));
  const spans = stored?.spans ?? new Map<string, { project: string; firstTs?: string }>();
  const sessions = outcomeSessions(data.sessions, own.keyOf, spans, judge.ledger);
  const byModel = (dim: string): boolean => !data.standing.dimensions.some((d) => d.dimension === dim);
  const states = fixStates(plans, stored?.applied ?? [], stored?.loaded ?? [], sessions, project, byModel)
    .map((f) => ({ ...f, ...own.meta.get(f.fixId), destination: destination(f), request: applyRequest([f]) }));
  return [...states, ...own.refused];
}

/**
 * Each session as the outcome counts it: occurrences per dimension, and per finding-fix key so a finding's own
 * fix counts its own constraint (`action:git push`), not its whole dimension.
 */
export function outcomeSessions(
  list: ReportData['sessions'],
  keyOf: Map<string, string>,
  spans: Map<string, { project: string; firstTs?: string }>,
  ledger: Record<string, number>,
): OutcomeSession[] {
  return list.map((s) => {
    const found: OutcomeSession['found'] = {};
    const keys: NonNullable<OutcomeSession['keys']> = {};
    const tally = (into: OutcomeSession['found'], k: string, times: number, turn: number | undefined): void => {
      const f = (into[k] ??= { times: 0 });
      f.times += times;
      if (f.turn === undefined && turn !== undefined && Number.isFinite(turn)) f.turn = turn;
    };
    for (const f of s.findings) tally(found, f.dimension, f.occurrences, Number(f.evidence[0]?.turn));
    for (const j of s.judged) {
      tally(found, j.dimension, 1, j.turns[0]);
      const key = j.id === undefined ? undefined : keyOf.get(j.id);
      if (key !== undefined) tally(keys, key, 1, j.turns[0]);
    }
    const span = spans.get(s.sessionId);
    const at = span?.firstTs ?? s.firstTs;
    return { id: s.sessionId, project: span?.project ?? '', ...(at !== undefined ? { at } : {}), judged: (ledger[s.sessionId] ?? 0) > 0, found, keys };
  });
}

/** The findings' own fixes, one per fix id however many findings share it. */
function ownFixes(archive: string, project: string): { plans: ApplyPlan[]; meta: Map<string, FixMeta>; refused: PaneFixOut[]; keyOf: Map<string, string> } {
  const stored = readFindingFixes(archive);
  const byFix = new Map<string, { fix: FindingFix; findingIds: string[] }>();
  for (const [id, x] of Object.entries(stored?.byFinding ?? {})) {
    const g = byFix.get(x.fixId) ?? { fix: x, findingIds: [] };
    g.findingIds.push(id);
    byFix.set(x.fixId, g);
  }
  const shared = new Map((stored?.shared ?? []).map((s) => [s.fix.fixId, s]));
  for (const s of shared.values()) if (!byFix.has(s.fix.fixId)) byFix.set(s.fix.fixId, { fix: s.fix, findingIds: [] });

  const plans: ApplyPlan[] = [];
  const meta = new Map<string, FixMeta>();
  const refused: PaneFixOut[] = [];
  for (const [fixId, { fix, findingIds }] of byFix) {
    const s = shared.get(fixId);
    const projects = s?.projects ?? [fix.project];
    const shown = fixDisplay(fix);
    const m: FixMeta = {
      findingIds,
      ...(s !== undefined ? { shared: { findings: s.findings, sessions: s.sessions } } : {}),
      kindLine: KIND_WORDS[fix.kind],
      whereLine: whereLine(fix, shown.destination),
      ...(fix.kind === 'agent' ? { shown: shown.body } : {}),
    };
    const plan = projects.includes(project) ? findingPlan(fix) : undefined;
    if (plan !== undefined) {
      plans.push(plan);
      meta.set(fixId, m);
    } else {
      refused.push({ fixId, dimension: fix.dimension, target: fix.target, text: fix.text, key: fix.key, destination: shown.destination, request: '', ...m, refusal: applyRefusal(fix, projects) });
    }
  }
  const keyOf = new Map(Object.entries(stored?.byFinding ?? {}).map(([id, x]) => [id, x.key]));
  return { plans, meta, refused, keyOf };
}

/**
 * How far the automatic reads have to go: the sessions they will read, how long today's share takes at
 * this machine's measured pace (absent until two runs are timed), and the day the daily limit lets them finish.
 */
function progressFor(
  state: JudgeState,
  archive: string,
  sizes: { id: string; sizeBytes: number; mtimeMs: number }[],
): { target: number; seconds?: number; finishOn?: string } {
  const queue = eligible(state, sizes, catchUpFrom(archive, state, sizes, false)).filter((s) => (state.ledger[s.id] ?? 0) === 0);
  const target = sizes.length - waitingOnRequest(archive, state, sizes);
  const measured = withStore(archive, (db) => ({ costs: sessionCosts(db), msPerToken: measuredMsPerToken(db) }));
  if (queue.length === 0 || measured === undefined) return { target };
  const tokens = queue.reduce((n, s) => n + (measured.costs.get(s.id) ?? 0), 0);
  const batches = Math.ceil(tokens / state.settings.maxBatchTokens);
  const need = tokens + batches * batchCost(0);
  const left = todayLeft(archive, state.settings.dailyTokens) ?? state.settings.dailyTokens;
  const share = need <= left ? 1 : left / need;
  const days = need <= left ? 0 : Math.ceil((need - left) / state.settings.dailyTokens);
  const finish = new Date();
  finish.setDate(finish.getDate() + days);
  return {
    target,
    ...(measured.msPerToken !== undefined && tokens > 0
      ? { seconds: Math.round(share * estimateQueueSeconds({ unread: queue.length, queueTokens: tokens, msPerToken: measured.msPerToken, budget: state.settings.maxBatchTokens, concurrency: state.settings.concurrency })) }
      : {}),
    ...(days > 0 ? { finishOn: finish.toISOString() } : {}),
  };
}

/** What the judge spent, and the limits on what it may spend next, for the pane's Health tab. */
function spendFor(
  state: JudgeState,
  archive: string,
  sizes: { id: string; sizeBytes: number; mtimeMs: number }[],
): {
  allTime?: Spend;
  last7d?: Spend;
  today?: { tokens: number; limit: number };
  older: number;
  catchUp: number;
  enabled: boolean;
  billing: 'api' | 'unknown';
} {
  const week = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const left = todayLeft(archive, state.settings.dailyTokens);
  const allTime = withStore(archive, readSpend);
  const last7d = withStore(archive, (db) => spendSince(db, week));
  // Set only for API or cloud billing; their absence proves nothing, so it stays unknown.
  const env = process.env;
  const api = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'].some((k) => (env[k] ?? '') !== '');
  return {
    ...(allTime === undefined ? {} : { allTime }),
    ...(last7d === undefined ? {} : { last7d }),
    ...(left === undefined ? {} : { today: { tokens: Math.max(state.settings.dailyTokens - left, 0), limit: state.settings.dailyTokens } }),
    older: waitingOnRequest(archive, state, sizes),
    catchUp: state.settings.catchUp,
    enabled: state.settings.enabled,
    billing: api ? 'api' : 'unknown',
  };
}
