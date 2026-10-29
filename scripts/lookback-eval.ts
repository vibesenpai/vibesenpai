#!/usr/bin/env node
/**
 * Does lookback keep real mistakes and drop suggestions? Re-judges a slice around each finding the person
 * labelled (`agentsensei label`), once without lookback and once with, and scores both against the labels.
 * `--all` takes every judge finding instead, labelled or not, and lists what lookback keeps and drops,
 * for reading. Both runs label the same extracted episodes, so a difference is the gate's, not extraction noise. Writes nothing to the store. Spends model calls: prints the estimate, sends only with --apply.
 *
 *   node --experimental-strip-types scripts/lookback-eval.ts [--all] [--apply] [model]
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { resolveConfig } from '../src/config.ts';
import { discoverTranscripts } from '../src/read.ts';
import { parseTranscript, withFullText } from '../src/parsers/claude-code.ts';
import { buildSession, estimateTokens, isHarnessNoise, JUDGE_OVERHEAD_TOKENS, type JudgePacketSession } from '../src/judge/packet.ts';
import { parseExtract, parseLabels, renderExtract, renderLabel, type JudgeEpisode, type JudgeFinding, type LabelResult, type Lookbacks } from '../src/judge/prompt.ts';
import { lookbacksFor } from '../src/judge/run.ts';
import { establishedLine } from '../src/judge/lookback.ts';
import { readJudgeState } from '../src/judge/state.ts';
import { callModel, wouldLeak } from '../src/judge/model.ts';
import { openStore, readLabels } from '../src/store.ts';

/** Events either side of a labelled finding: enough for its episode, small enough to be cheap. */
const SLICE = 40;
/** A re-judged finding answers a labelled one when it is in the same session within this many turns. */
const NEAR = 25;
const BATCH_TOKENS = 50_000;

type Case = { key: string; sessionId: string; dimension: string; verdict: string; turns: number[] };

function slices(cases: Case[], sources: string[]): JudgePacketSession[] {
  const files = new Map(discoverTranscripts(sources).map((f) => [basename(f, '.jsonl'), f]));
  const out: JudgePacketSession[] = [];
  const bySession = new Map<string, Case[]>();
  for (const c of cases) bySession.set(c.sessionId, [...(bySession.get(c.sessionId) ?? []), c]);
  for (const [sessionId, mine] of bySession) {
    const file = files.get(sessionId);
    if (file === undefined) continue;
    const r = withFullText(() => parseTranscript(readFileSync(file, 'utf8').split('\n'), sessionId));
    const events = [...r.result.events].sort((a, b) => a.seq - b.seq);
    const prompts = events
      .filter((e) => e.turnType === 'user_prompt')
      .map((e) => ({ seq: e.seq, text: r.fullText.get(e.seq) ?? e.textSummary ?? '' }))
      .filter((p) => p.text !== '' && !isHarnessNoise(p.text));
    for (const c of mine) {
      const lo = Math.min(...c.turns) - SLICE;
      const hi = Math.max(...c.turns) + SLICE;
      const slice = events.filter((e) => e.seq >= lo && e.seq <= hi);
      const s = buildSession(`${sessionId}#${c.key}`, slice, r.fullText);
      if (s.packet.turns.length > 0) out.push({ ...s, lookback: { prompts, instructions: r.instructions } });
    }
  }
  return out;
}

function batches(sessions: JudgePacketSession[]): JudgePacketSession[][] {
  const out: JudgePacketSession[][] = [];
  let cur: JudgePacketSession[] = [];
  for (const s of sessions) {
    if (cur.length > 0 && estimateTokens(renderExtract([...cur, s])) > BATCH_TOKENS) {
      out.push(cur);
      cur = [];
    }
    cur.push(s);
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

type Paired = { off: JudgeFinding[]; on: JudgeFinding[]; gated: LabelResult['gated']; episodes: JudgeEpisode[] };

/** One extract, then the same episodes labelled without lookback and with it. */
function judgePaired(batch: JudgePacketSession[], model: string): Paired {
  const extractPacket = renderExtract(batch);
  if (wouldLeak(extractPacket)) throw new Error('extract packet failed the redaction gate');
  const a = callModel(extractPacket, model, { timeoutMs: 180_000 });
  if (a === undefined) throw new Error('extract call failed');
  const { episodes } = parseExtract(a.reply, batch);
  if (episodes.length === 0) return { off: [], on: [], gated: [], episodes };
  const label = (lookbacks: Lookbacks | undefined): LabelResult => {
    const packet = renderLabel(episodes, lookbacks);
    if (wouldLeak(packet)) throw new Error('label packet failed the redaction gate');
    const b = callModel(packet, model, { timeoutMs: 180_000 });
    if (b === undefined) throw new Error('label call failed');
    return parseLabels(b.reply, episodes, lookbacks);
  };
  const off = label(undefined);
  const on = label(lookbacksFor(batch, episodes, estimateTokens(extractPacket)));
  return { off: off.findings, on: on.findings, gated: on.gated, episodes };
}

function main(): void {
  const apply = process.argv.includes('--apply');
  const model = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'haiku';
  const { config } = resolveConfig();

  const db = openStore(config.archive);
  const labels = readLabels(db);
  db.close();
  const all = readJudgeState(config.archive, { dismissed: 'include' }).findings;
  const found = new Map(all.map((f) => [f.id, f]));
  const verdicts = new Map(labels.map((l) => [l.key, l.verdict]));
  const cases: Case[] = process.argv.includes('--all')
    ? all.filter((f) => f.id !== undefined).map((f) => ({ key: f.id as string, sessionId: f.sessionId, dimension: f.dimension, verdict: verdicts.get(f.id as string) ?? 'unlabelled', turns: f.turns }))
    : labels.flatMap((l) => {
        const f = found.get(l.key);
        return f === undefined ? [] : [{ key: l.key, sessionId: f.sessionId, dimension: f.dimension, verdict: l.verdict, turns: f.turns }];
      });
  const counts = Object.fromEntries(['mistake', 'suggestion', 'wrong', 'unlabelled'].map((v) => [v, cases.filter((c) => c.verdict === v).length]));
  console.log(`labelled judge findings: ${cases.length} (${JSON.stringify(counts)})`);
  if (cases.length === 0) return;

  const sessions = slices(cases, config.sources);
  const groups = batches(sessions);
  const tokens = groups.reduce((n, g) => n + estimateTokens(renderExtract(g)) + JUDGE_OVERHEAD_TOKENS, 0);
  // Per batch: one extract call and two label calls.
  console.log(`${sessions.length} slice(s) in ${groups.length} batch(es): about ${Math.round((tokens + groups.length * 2 * 30_000) / 1000)}k tokens`);
  if (!apply) {
    console.log('nothing sent. re-run with --apply.');
    return;
  }

  const runs = groups.map((g) => judgePaired(g, model));
  const off = runs.flatMap((r) => r.off);
  const on = runs.flatMap((r) => r.on);
  const gated = runs.flatMap((r) => r.gated);
  const near = (turns: number[], c: Case): boolean => turns.some((t) => c.turns.some((u) => Math.abs(t - u) <= NEAR));
  const mine = (sid: string, c: Case): boolean => sid === `${c.sessionId}#${c.key}`;

  // For reading: each original finding, what the same episodes became without and with lookback.
  const tally = new Map<string, number>();
  for (const c of cases) {
    const orig = found.get(c.key);
    const extracted = runs.some((r) => r.episodes.some((e) => mine(e.sessionId, c) && near(e.evidence.flatMap((v) => v.turns), c)));
    const o = off.find((f) => mine(f.sessionId, c) && near(f.turns, c));
    const n = on.find((f) => mine(f.sessionId, c) && near(f.turns, c));
    const g = gated.find((x) => mine(x.episode.sessionId, c) && near(x.episode.evidence.flatMap((v) => v.turns), c));
    const outcome = !extracted ? 'not re-extracted' : n !== undefined ? 'kept' : g !== undefined ? 'gated' : 'unlabelled';
    tally.set(outcome, (tally.get(outcome) ?? 0) + 1);
    console.log(`\n${outcome.toUpperCase()} · was ${c.dimension} · ${c.verdict} · ${c.sessionId.slice(0, 8)} turns ${c.turns.join(',')}`);
    console.log(`  quote: ${(orig?.quote ?? orig?.why ?? '').slice(0, 160)}`);
    if (o !== undefined) console.log(`  off:   ${o.dimension}`);
    if (n !== undefined) console.log(`  on:    ${n.dimension}${n.established === undefined ? '' : ` · established ${establishedLine(n.established)}`}`);
    if (g !== undefined && n === undefined) console.log(`  gate:  ${g.dimension} · ${g.reason}${g.established === undefined ? '' : ` · cited ${g.established.source} “${g.established.quote.slice(0, 120)}”`}`);
  }
  const reasons = new Map<string, number>();
  for (const g of gated) reasons.set(g.reason, (reasons.get(g.reason) ?? 0) + 1);
  const dims = (fs: JudgeFinding[]) => JSON.stringify(Object.fromEntries([...new Set(fs.map((f) => f.dimension))].map((d) => [d, fs.filter((f) => f.dimension === d).length])));
  console.log(`\noutcomes: ${JSON.stringify(Object.fromEntries(tally))}`);
  console.log(`same episodes · off ${off.length} findings ${dims(off)} · on ${on.length} findings ${dims(on)} · gated ${gated.length}`);
  console.log(`gate reasons: ${JSON.stringify(Object.fromEntries(reasons))}`);
  if (labels.length > 0) {
    const score = (findings: JudgeFinding[]) => {
      const by = (v: string) => cases.filter((c) => c.verdict === v && findings.some((f) => mine(f.sessionId, c) && near(f.turns, c))).length;
      return `mistakes kept ${by('mistake')}/${counts['mistake']} · suggestions kept ${by('suggestion')}/${counts['suggestion']} · wrong kept ${by('wrong')}/${counts['wrong']}`;
    };
    console.log(`lookback off: ${score(off)}\nlookback on:  ${score(on)}`);
  }
}

main();
