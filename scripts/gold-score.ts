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
import { buildSession, parseResponse, renderPacket, type JudgePacketSession } from '../src/judge.ts';
import { JUDGE_CWD_MARKER } from '../src/read.ts';
import { loadGold, locateSessions, locateTurns, score, type JudgeOutput } from '../src/gold.ts';
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
    spent.calls++;
    return r.result;
  } catch {
    return undefined;
  }
}

const spent = { calls: 0, input: 0, output: 0 };

async function main(): Promise<void> {
  const limit = Number(process.argv[2] ?? '30');
  const model = process.argv[3] ?? 'haiku';

  const episodes = loadGold(GOLD_JSON);
  const files = locateSessions(episodes, SESSION_DIRS);
  const shas = [...files.keys()].slice(0, limit);

  console.log(`gold · ${episodes.length} swe episodes · ${files.size} sessions held · judging ${shas.length} · ${model}\n`);

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
      located.set(`${sha}:${ep.misalignmentId}`, locateTurns(ep, events));
    }
  }

  // Pack to the ceiling. Whole sessions only — a halved packet yields findings
  // about turns whose other half was never shown.
  const batches: JudgePacketSession[][] = [];
  let current: JudgePacketSession[] = [];
  for (const p of packets) {
    const next = [...current, p];
    if (current.length > 0 && Math.round((renderPacket(next).length / 4) * 1.9) > BATCH_TOKENS) {
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
    const text = renderPacket(batch);
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
    const r = parseResponse(reply, batch);
    for (const d of r.dropped) dropped[d.reason] = (dropped[d.reason] ?? 0) + d.count;
    found.push(...r.findings.map((f) => ({ sessionId: f.sessionId, dimension: f.dimension, turns: f.turns })));
    console.log(`${r.findings.length} kept`);
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

  const s = score(episodes, located, found, packets.map((p) => p.sessionId));

  console.log(`\n  sessions judged          : ${s.sessionsJudged}`);
  console.log(`  labelled claims in scope : ${s.inScope}`);
  console.log(`  out of scope (S1/S5/S6)  : ${s.outOfScope}  — the packet cannot show these`);
  console.log('');
  console.log(`  MATCHED                  : ${s.matched}`);
  console.log(`  recall                   : ${s.recall === undefined ? 'n/a' : `${(s.recall * 100).toFixed(0)}%`}`);
  console.log(`  right dimension, wrong place: ${s.rightDimensionWrongPlace}`);
  console.log(`  unmatched findings       : ${s.unmatched}  — read these; they are not automatically wrong`);
  console.log('');
  for (const [dim, v] of Object.entries(s.byDimension)) {
    console.log(`    ${dim.padEnd(24)} ${v.matched}/${v.inScope}`);
  }
  if (Object.keys(dropped).length > 0) console.log(`\n  gate dropped: ${JSON.stringify(dropped)}`);
  console.log(`\n  spent: ${spent.calls} call(s) · ${spent.input.toLocaleString()} in · ${spent.output.toLocaleString()} out`);
}

main().catch((e: unknown) => {
  console.error(String(e));
  process.exit(1);
});
