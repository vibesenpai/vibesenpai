#!/usr/bin/env node
/**
 * Score the judge against the paper's labelled episodes.
 *
 *   node --experimental-strip-types scripts/gold-score.ts [limit] [model]
 *
 * Needs `misalignments.json` from the replication package:
 *   git clone --depth 1 https://github.com/ND-SaNDwichLAB/coding-agent-misalignment
 * and the SWE-chat transcripts, via `VIBESENPAI_GOLD_SESSIONS`.
 *
 * Measures recall only: findings the paper did not record are "unmatched", not false
 * positives, since the gold set is not known to be complete. Batched because invocation
 * overhead dwarfs a session.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseTranscript, withFullText } from '../src/parsers/claude-code.ts';
import { parseExtract, parseLabels, renderExtract, renderLabel } from '../src/judge/prompt.ts';
import { buildSession, estimateTokens, JUDGE_OVERHEAD_TOKENS, type JudgePacketSession } from '../src/judge/packet.ts';
import { callModel, wouldLeak } from '../src/judge/model.ts';
import { loadGold, loadNegatives, locateSessions, locateTurns, score, type JudgeOutput } from './gold.ts';
import type { Event } from '../src/types.ts';

const GOLD_JSON = process.env['VIBESENPAI_GOLD'] ?? '/tmp/cam-check/misalignments.json';

/** The commit this ran against, and whether the tree was dirty. */
function provenance(): { commit: string; dirty: boolean } {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '';
    return { commit, dirty };
  } catch {
    return { commit: 'unknown', dirty: false };
  }
}
const SESSION_DIRS = (process.env['VIBESENPAI_GOLD_SESSIONS'] ?? '').split(',').filter(Boolean);
const BATCH_TOKENS = 55_000;

/** One model call, accumulating spend. Dollars appear here only; the product reports tokens. */
function call(packet: string, model: string): string | undefined {
  const r = callModel(packet, model);
  if (r === undefined) return undefined;
  spent.input += r.inputTokens;
  spent.output += r.outputTokens;
  spent.usd += r.usd;
  spent.calls++;
  return r.reply;
}

// `total_cost_usd` is the harness's own figure, not derived from a price table.
const spent = { calls: 0, input: 0, output: 0, usd: 0 };

async function main(): Promise<void> {
  // Default to every session; a sample must be asked for explicitly.
  const limit = process.argv[2] === undefined ? Number.MAX_SAFE_INTEGER : Number(process.argv[2]);
  const model = process.argv[3] ?? 'haiku';

  const episodes = loadGold(GOLD_JSON);

  // `--negatives`: sessions their pipeline found nothing in, so every finding is a false-positive candidate.
  const negativesMode = process.argv.includes('--negatives');
  // `--extract-only` stops after stage A, so extraction is measured on its own.
  const extractOnly = process.argv.includes('--extract-only');
  // `--paired`: each batch's records are labelled twice, without secondary kinds and with, so the difference is the label stage's.
  const paired = process.argv.includes('--paired');
  // `--estimate`: print the batches and their size, send nothing.
  const estimateOnly = process.argv.includes('--estimate');
  let files: Map<string, string>;
  if (negativesMode) {
    const mapping = process.env['VIBESENPAI_GOLD_MAPPING'] ?? '/tmp/cam-check/data/core/session_mapping.json';
    const negative = loadNegatives(mapping, episodes);
    files = locateSessions(
      [...negative].map((sessionSha) => ({ sessionSha }) as never),
      SESSION_DIRS,
    );
  } else {
    files = locateSessions(episodes, SESSION_DIRS);
  }
  const shas = [...files.keys()].slice(0, limit);

  const mode = extractOnly ? 'extract-only (stage A)' : 'two-stage';
  console.log(`gold · ${episodes.length} swe episodes · ${files.size} sessions held · judging ${shas.length} · ${model} · ${mode}\n`);

  // Parse once: the packet and the quote alignment both need the events.
  const packets: JudgePacketSession[] = [];
  const located = new Map<string, number[]>();

  for (const sha of shas) {
    const path = files.get(sha) as string;
    let events: Event[];
    let fullText: Map<number, string>;
    try {
      const r = withFullText(() => parseTranscript(readFileSync(path, 'utf8').split('\n'), sha));
      events = [...r.result.events].sort((a, b) => a.seq - b.seq);
      fullText = r.fullText;
    } catch {
      continue;
    }
    if (events.length === 0) continue;

    const p = buildSession(sha, events, fullText);
    if (p.packet.turns.length === 0) continue;
    packets.push(p);

    for (const ep of episodes) {
      if (ep.sessionSha !== sha) continue;
      located.set(`${sha}:${ep.misalignmentId}`, locateTurns(ep, events, fullText));
    }
  }

  // Pack whole sessions to the ceiling, sized by the prompt actually sent (`renderExtract`).
  const batches: JudgePacketSession[][] = [];
  let current: JudgePacketSession[] = [];
  for (const p of packets) {
    const next = [...current, p];
    if (current.length > 0 && estimateTokens(renderExtract(next)) > BATCH_TOKENS) {
      batches.push(current);
      current = [p];
    } else {
      current = next;
    }
  }
  if (current.length > 0) batches.push(current);

  if (estimateOnly) {
    const extract = batches.reduce((n, b) => n + estimateTokens(renderExtract(b)) + JUDGE_OVERHEAD_TOKENS, 0);
    // Label calls: about the invocation overhead each, one per batch, two when paired.
    const label = batches.length * (paired ? 2 : 1) * JUDGE_OVERHEAD_TOKENS;
    console.log(`${packets.length} sessions in ${batches.length} batches: about ${Math.round((extract + label) / 1000)}k tokens. nothing sent.`);
    return;
  }

  const found: JudgeOutput[] = [];
  /** With `--paired`: the same records labelled without secondary kinds. */
  const foundMain: JudgeOutput[] = [];
  const dropped: Record<string, number> = {};
  for (const [i, batch] of batches.entries()) {
    process.stdout.write(`  batch ${i + 1}/${batches.length} (${batch.length} sessions) … `);
    const text = renderExtract(batch);
    // The same redaction gate the runner enforces.
    if (wouldLeak(text)) {
      console.log('REFUSED by the redaction gate');
      continue;
    }
    const reply = call(text, model);
    if (reply === undefined) {
      console.log('call failed');
      continue;
    }

    {
      const ex = parseExtract(reply, batch);
      for (const d of ex.dropped) dropped[d.reason] = (dropped[d.reason] ?? 0) + d.count;
      if (ex.episodes.length === 0) {
        console.log('0 episodes');
        continue;
      }
      if (extractOnly) {
        // A placeholder dimension, never reported: only session and episode numbers mean anything here.
        found.push(
          ...ex.episodes.map((e) => ({
            sessionId: e.sessionId,
            dimension: 'constraint_violation' as const,
            turns: e.evidence.flatMap((v) => v.turns),
            quote: e.evidence[0]?.quote ?? '',
          })),
        );
        console.log(`${ex.episodes.length} episode(s), unlabelled`);
        continue;
      }
      const labelReply = call(renderLabel(ex.episodes), model);
      if (labelReply === undefined) {
        console.log(`${ex.episodes.length} episode(s), LABEL CALL FAILED`);
        continue;
      }
      if (paired) {
        const mainReply = call(renderLabel(ex.episodes, undefined, { secondary: false }), model);
        if (mainReply !== undefined) {
          foundMain.push(...parseLabels(mainReply, ex.episodes).findings.map((f) => ({ sessionId: f.sessionId, dimension: f.dimension, turns: f.turns })));
        }
      }
      const lb = parseLabels(labelReply, ex.episodes);
      for (const d of lb.dropped) dropped[d.reason] = (dropped[d.reason] ?? 0) + d.count;
      found.push(
        ...lb.findings.map((f) => ({
          sessionId: f.sessionId,
          dimension: f.dimension,
          ...(f.secondaryDimensions !== undefined ? { secondaryDimensions: f.secondaryDimensions } : {}),
          turns: f.turns,
          quote: f.quote,
        })),
      );
      console.log(`${ex.episodes.length} episode(s) -> ${lb.findings.length} labelled`);
    }
  }

  // Persisted so scoring can be re-run without paying for the model again.
  const cache = process.env['VIBESENPAI_GOLD_CACHE'];
  if (cache !== undefined) {
    writeFileSync(cache, JSON.stringify({
      // The commit and dirty flag, so results from different code are never compared as variance.
      code: provenance(),
      found,
      ...(paired ? { foundMain } : {}),
      sessions: packets.map((p) => p.sessionId),
      located: [...located],
    }, null, 2));
    console.log(`\n  findings cached to ${cache}`);
  }

  if (negativesMode) {
    const bySession = new Map<string, number>();
    for (const f of found) bySession.set(f.sessionId, (bySession.get(f.sessionId) ?? 0) + 1);
    const byDim: Record<string, number> = {};
    for (const f of found) byDim[f.dimension] = (byDim[f.dimension] ?? 0) + 1;
    console.log(`\n  LABELLED-NEGATIVE sessions judged : ${packets.length}`);
    console.log(`  sessions where we found something : ${bySession.size}`);
    console.log(`  findings (all false-positive candidates) : ${found.length}`);
    console.log(`  per dimension: ${JSON.stringify(byDim)}`);
    const also: Record<string, number> = {};
    for (const f of found) for (const k of f.secondaryDimensions ?? []) also[k] = (also[k] ?? 0) + 1;
    console.log(`  secondary kinds: ${JSON.stringify(also)}`);
    if (paired) console.log(`  labelled without secondary kinds: ${foundMain.length} findings`);
    console.log(
      `\n  spent: ${spent.calls} call(s) · ${spent.input.toLocaleString()} in · ` +
        `${spent.output.toLocaleString()} out` +
        (spent.usd > 0 ? ` · $${spent.usd.toFixed(2)} (harness-reported)` : ''),
    );
    return;
  }

  const s = score(episodes, located, found, packets.map((p) => p.sessionId));
  // The same findings with only their main kind: comparable with runs before secondary kinds existed.
  const primaryOnly = score(episodes, located, found.map(({ secondaryDimensions: _, ...f }) => f), packets.map((p) => p.sessionId));

  const pct = (r: number | undefined): string => (r === undefined ? 'n/a' : `${(r * 100).toFixed(0)}%`);

  console.log(`\n  sessions judged          : ${s.sessionsJudged}`);
  console.log(`  out of scope (S1/S5/S6)  : ${s.outOfScope}  — the packet cannot show these`);
  console.log('');
  // Loosest first. All three need a finding within TURN_TOLERANCE of located evidence.
  console.log(`  SESSION-level  (any dimension) : ${s.sessionLevel.caught}/${s.sessionLevel.withEpisode}   ${pct(s.sessionLevel.recall)}   <- headline`);
  console.log(`  episode-level  (any dimension) : ${s.episodeLevel.caught}/${s.episodeLevel.total}   ${pct(s.episodeLevel.recall)}`);
  console.log(`  caught as one of the four kinds: ${s.caughtAnyKind.caught}/${s.caughtAnyKind.total}   ${pct(s.caughtAnyKind.recall)}`);
  for (const [dim, v] of Object.entries(s.caughtAnyKind.byDimension)) console.log(`    ${dim.padEnd(24)} caught ${v.caught}/${v.total}`);
  console.log(
    `  claim-level    (exact dimension): ${s.matched}/${s.inScope}   ${pct(s.recall)}` +
      (extractOnly ? '   <- MEANINGLESS in extract-only mode, the dimension is a placeholder' : ''),
  );
  console.log(`  claim-level, main kind only    : ${primaryOnly.matched}/${primaryOnly.inScope}   ${pct(primaryOnly.recall)}`);
  const unpaired = paired ? score(episodes, located, foundMain, packets.map((p) => p.sessionId)) : undefined;
  if (unpaired !== undefined) {
    console.log(`  claim-level, labelled without secondary kinds: ${unpaired.matched}/${unpaired.inScope}   ${pct(unpaired.recall)}   (${foundMain.length} findings against ${found.length})`);
    for (const [dim, v] of Object.entries(unpaired.byDimension)) console.log(`    without: ${dim.padEnd(24)} ${v.matched}/${v.inScope}`);
  }
  console.log('');
  console.log(`  right dimension, wrong place: ${s.rightDimensionWrongPlace}`);
  console.log(`  unmatched findings       : ${s.unmatched}  — read these; they are not automatically wrong`);
  console.log('');
  for (const [dim, v] of Object.entries(s.byDimension)) {
    console.log(`    ${dim.padEnd(24)} ${v.matched}/${v.inScope}   (main kind only ${primaryOnly.byDimension[dim]?.matched ?? 0})`);
  }
  const conf = Object.entries(s.confusion).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (conf.length > 0) {
    console.log('\n  label disagreements (ours -> theirs), on episodes we DID locate:');
    for (const [k, n] of conf) console.log(`    ${k.padEnd(46)} ${n}`);
  }
  if (Object.keys(dropped).length > 0) console.log(`\n  gate dropped: ${JSON.stringify(dropped)}`);
  console.log(
    `\n  spent: ${spent.calls} call(s) · ${spent.input.toLocaleString()} in · ` +
      `${spent.output.toLocaleString()} out` +
      (spent.usd > 0 ? ` · $${spent.usd.toFixed(2)} (harness-reported)` : ''),
  );
}

main().catch((e: unknown) => {
  console.error(String(e));
  process.exit(1);
});
