#!/usr/bin/env node
/**
 * Score the judge against the paper's labelled episodes.
 *
 *   node --experimental-strip-types scripts/gold-score.ts [limit] [model]
 *
 * Needs `misalignments.json` from the replication package:
 *   git clone --depth 1 https://github.com/ND-SaNDwichLAB/coding-agent-misalignment
 * and the SWE-chat transcripts, via `AGENTSENSEI_GOLD_SESSIONS`.
 *
 * ── Recall is measured; precision is not claimed ───────────────────────────
 *
 * The paper released the episodes it found, so a judge finding it did not
 * record may be a miss of theirs rather than an invention of ours. Calling
 * those false positives would quietly assume the gold set is complete, which
 * nothing supports. They are counted as **unmatched, awaiting adjudication**,
 * and reading them is the next step rather than a number to report.
 *
 * ── Batched, because the overhead is the cost ──────────────────────────────
 *
 * ~27,000 tokens of invocation overhead dwarf a ~3,000-token session, so
 * sessions are packed to the ceiling and sent together — the same argument as
 * `scripts/judge.ts`, and the reason this is affordable at all.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTranscript, withFullText } from '../src/parsers/claude-code.ts';
import { buildSession, estimateTokens, parseExtract, parseLabels, renderExtract, renderLabel, type JudgePacketSession } from '../src/judge.ts';
import { JUDGE_CWD_MARKER } from '../src/read.ts';
import { loadGold, loadNegatives, locateSessions, locateTurns, score, type JudgeOutput } from '../src/gold.ts';
import { redact } from '../src/redact.ts';
import type { Event } from '../src/types.ts';

const GOLD_JSON = process.env['AGENTSENSEI_GOLD'] ?? '/tmp/cam-check/misalignments.json';
const SESSION_DIRS = (process.env['AGENTSENSEI_GOLD_SESSIONS'] ?? '').split(',').filter(Boolean);
const BATCH_TOKENS = 55_000;

function callModel(packet: string, model: string): string | undefined {
  const cwd = join(tmpdir(), JUDGE_CWD_MARKER);
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  try {
    const out = execFileSync(
      'claude',
      ['-p', packet, '--output-format', 'json', '--allowed-tools', '', '--model', model],
      {
        cwd,
        encoding: 'utf8',
        timeout: 300_000,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, AGENTSENSEI_DISABLE: '1' },
      },
    );
    const r = JSON.parse(out) as { is_error?: boolean; result?: string; usage?: Record<string, number> };
    if (r.is_error === true || typeof r.result !== 'string') return undefined;
    const u = r.usage ?? {};
    spent.input += (u['cache_creation_input_tokens'] ?? 0) + (u['cache_read_input_tokens'] ?? 0) + (u['input_tokens'] ?? 0);
    spent.output += u['output_tokens'] ?? 0;
    spent.usd += (r as { total_cost_usd?: number }).total_cost_usd ?? 0;
    spent.calls++;
    return r.result;
  } catch {
    return undefined;
  }
}

// `total_cost_usd` comes back from the harness itself, so it is measured
// rather than derived from a price table we would have to keep current.
const spent = { calls: 0, input: 0, output: 0, usd: 0 };

async function main(): Promise<void> {
  const limit = Number(process.argv[2] ?? '30');
  const model = process.argv[3] ?? 'haiku';

  const episodes = loadGold(GOLD_JSON);

  // `--negatives` scores the other half of the question: on sessions their
  // pipeline examined and found nothing in, every finding is a false-positive
  // candidate. Recall alone cannot say whether we are better or merely noisier.
  const negativesMode = process.argv.includes('--negatives');
  // Extract-then-label is the only path; `--extract-only` stops after stage A
  // and assigns no real dimension, which isolates EXTRACTION. The session- and
  // episode-level numbers are dimension-agnostic, so they mean something
  // without stage B having run — which is how the two halves get measured
  // separately rather than as one bundle.
  const extractOnly = process.argv.includes('--extract-only');
  let files: Map<string, string>;
  if (negativesMode) {
    const mapping = process.env['AGENTSENSEI_GOLD_MAPPING'] ?? '/tmp/cam-check/data/core/session_mapping.json';
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

  // Pack to the ceiling. Whole sessions only — a halved packet yields findings
  // about turns whose other half was never shown.
  // Size a batch by the prompt that will actually be SENT. This measured
  // `renderPacket` while the two-stage path sent `renderExtract` — a different,
  // differently-sized string — so two-stage batches were composed against the
  // wrong budget. Both arms used the same (wrong) function, so the 56%-vs-71%
  // comparison stands; the call count does not.
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

  const found: JudgeOutput[] = [];
  const dropped: Record<string, number> = {};
  for (const [i, batch] of batches.entries()) {
    process.stdout.write(`  batch ${i + 1}/${batches.length} (${batch.length} sessions) … `);
    const text = renderExtract(batch);
    // The same gate the runner enforces. A scoring harness that sent what the
    // product refuses to send would be measuring a different system.
    if (redact(text).text !== text) {
      console.log('REFUSED by the redaction gate');
      continue;
    }
    const reply = callModel(text, model);
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
        // A placeholder dimension, never reported. Only the dimension-agnostic
        // session and episode numbers mean anything in this mode, and the
        // output says so.
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
      const labelReply = callModel(renderLabel(ex.episodes), model);
      if (labelReply === undefined) {
        console.log(`${ex.episodes.length} episode(s), LABEL CALL FAILED`);
        continue;
      }
      const lb = parseLabels(labelReply, ex.episodes);
      for (const d of lb.dropped) dropped[d.reason] = (dropped[d.reason] ?? 0) + d.count;
      found.push(
        ...lb.findings.map((f) => ({
          sessionId: f.sessionId,
          dimension: f.dimension,
          turns: f.turns,
          quote: f.quote,
        })),
      );
      console.log(`${ex.episodes.length} episode(s) -> ${lb.findings.length} labelled`);
    }
  }

  // Persisted so the scoring can be re-run without paying for the model again.
  // The first run cost 363,719 input tokens; a threshold question is not worth
  // repeating that, and re-running to get a nicer number would be worse still.
  const cache = process.env['AGENTSENSEI_GOLD_CACHE'];
  if (cache !== undefined) {
    writeFileSync(cache, JSON.stringify({
      found,
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
    console.log(
      `\n  spent: ${spent.calls} call(s) · ${spent.input.toLocaleString()} in · ` +
        `${spent.output.toLocaleString()} out` +
        (spent.usd > 0 ? ` · $${spent.usd.toFixed(2)} (harness-reported)` : ''),
    );
    return;
  }

  const s = score(episodes, located, found, packets.map((p) => p.sessionId));

  const pct = (r: number | undefined): string => (r === undefined ? 'n/a' : `${(r * 100).toFixed(0)}%`);

  console.log(`\n  sessions judged          : ${s.sessionsJudged}`);
  console.log(`  out of scope (S1/S5/S6)  : ${s.outOfScope}  — the packet cannot show these`);
  console.log('');
  // Loosest first: this is the unit the product is built around. Every one of
  // the three requires a finding within TURN_TOLERANCE of located evidence —
  // they differ only in the denominator and whether the LABEL must match.
  console.log(`  SESSION-level  (any dimension) : ${s.sessionLevel.caught}/${s.sessionLevel.withEpisode}   ${pct(s.sessionLevel.recall)}   <- headline`);
  console.log(`  episode-level  (any dimension) : ${s.episodeLevel.caught}/${s.episodeLevel.total}   ${pct(s.episodeLevel.recall)}`);
  console.log(
    `  claim-level    (exact dimension): ${s.matched}/${s.inScope}   ${pct(s.recall)}` +
      (extractOnly ? '   <- MEANINGLESS in extract-only mode, the dimension is a placeholder' : ''),
  );
  console.log('');
  console.log(`  right dimension, wrong place: ${s.rightDimensionWrongPlace}`);
  console.log(`  unmatched findings       : ${s.unmatched}  — read these; they are not automatically wrong`);
  console.log('');
  for (const [dim, v] of Object.entries(s.byDimension)) {
    console.log(`    ${dim.padEnd(24)} ${v.matched}/${v.inScope}`);
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
