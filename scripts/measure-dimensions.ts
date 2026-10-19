/**
 * How often does each dimension actually occur?
 *
 * Every frequency this project publishes comes from here, over the same pinned
 * 1,139-session SWE-chat corpus, so a number in a doc can be reproduced rather
 * than taken on trust. `npm run measure`.
 *
 * ── Rules this script holds itself to ───────────────────────────────────────
 *
 * 1. **Every number carries its denominator.** "23 corrections" means nothing;
 *    "23 of 180 prompts" does.
 * 2. **A built dimension is measured by its own detector, not by a probe that
 *    resembles it.** A detector that disagrees with the measurement justifying
 *    it is wrong, and a probe looser than the detector hides exactly that: the
 *    loose `tool_loop` probe reported 4% of sessions where the real detector
 *    found 0.4%.
 * 3. **A probe over a harness mechanism must first establish that the mechanism
 *    means what its name suggests.** This rule cost most of a week. `enqueue`
 *    is not an interrupt — 3,504 of 3,606 sit at a turn boundary and 1,858
 *    carry `<task-notification>`. `remove` is not a withdrawal; the queue
 *    operations balance. A non-zero exit is not an ignored error; ≥68 of 234
 *    were the agent fixing. Every push is not a premature write. And
 *    `cache_read` is not a hit rate: it re-counts the whole prefix per call, so
 *    `read/(read+creation)` runs p10 0.901 to p90 0.985 whatever anyone does.
 * 4. **Every probe states its confound**, in the table, next to the number.
 * 5. **Where SWE-chat has a label, the label wins.** `prompt_pushback` is
 *    annotated on 201,485 prompts and validated in the paper; our regex is not
 *    evidence against it.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from '../src/parsers/index.ts';
import { editEvidenceOf, READ_TOOLS } from '../src/edits.ts';
import { callFailed, countDenominators } from '../src/detect/index.ts';
import { retriedFailures } from '../src/detect/edit-retry.ts';
import { reasonOf } from '../src/detect/labels.ts';
import type { Event } from '../src/types.ts';

/**
 * How a number was arrived at, which bounds how much it is worth.
 *
 * `detector` is the strongest: the shipped rule itself ran, so the figure and
 * the product cannot disagree. `structural` is a probe over harness-recorded
 * fields for a dimension not yet built. `labelled` defers to SWE-chat's own
 * validated annotations. `lexical` reads text and is an upper bound, never a
 * measurement — no probe here is lexical any more, and the value is kept so
 * that reintroducing one has to be spelled out.
 */
type Probe = 'detector' | 'structural' | 'labelled' | 'lexical';

type Row = {
  dimension: string;
  /** Sessions in which the signal occurred at least once. */
  sessions: number;
  /** Total occurrences. */
  instances: number;
  denominator: string;
  probe: Probe;
  /** What would make this number wrong. Required. */
  confound: string;
  inCatalogue: boolean;
};

type Session = { id: string; project: string; events: Event[]; set: 'A' | 'B' };

/** Per-turn labels from SWE-chat, keyed `session_id:turn_number`. */
function loadLabels(path: string): Map<string, { pushback?: string; intent?: string }> {
  const out = new Map<string, { pushback?: string; intent?: string }>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      const key = `${String(r['session_id'])}:${String(r['turn_number'])}`;
      out.set(key, {
        ...(typeof r['prompt_pushback'] === 'string' ? { pushback: r['prompt_pushback'] } : {}),
        ...(typeof r['prompt_intent'] === 'string' ? { intent: r['prompt_intent'] } : {}),
      });
    } catch { /* a truncated last line while the pull runs */ }
  }
  return out;
}

function loadSessions(dir: string, set: 'A' | 'B'): Session[] {
  if (!existsSync(dir)) return [];
  const out: Session[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const id = basename(f, '.jsonl');
    let r;
    try { r = parse(join(dir, f), readFileSync(join(dir, f), 'utf8'), id); } catch { continue; }
    if (Object.keys(r.unknown).some((k) => k.startsWith('unsupported-harness'))) continue;
    if (r.events.length === 0) continue;
    // Project = the repo this session belongs to, which the transcript does not
    // carry; the session id is a safe stand-in for per-session verification.
    out.push({ id, project: id, events: r.events, set });
  }
  return out;
}

/** Everything a probe needs, computed once per session. */
type Ctx = {
  s: Session;
  ev: Event[];
  prompts: Event[];
  edits: Event[];
  toolCalls: Event[];
};

type ProbeDef = {
  dimension: string;
  denominator: string;
  probe: Probe;
  confound: string;
  inCatalogue: boolean;
  count(c: Ctx): number;
};

const PROBES: ProbeDef[] = [
  // ── Built: measured by the shipped detector itself ────────────────────────
  {
    dimension: 'edit_retry',
    denominator: 'per edit',
    probe: 'detector',
    confound:
      'only failureKind "tool" counts, so a denied or hook-blocked edit is excluded; ' +
      'the attempt ends at the next user prompt',
    inCatalogue: true,
    // The real function the detector calls, not a lookalike. A probe looser
    // than the detector hides the only disagreement worth knowing about.
    count: (c) => retriedFailures(c.ev).length,
  },

  // ── Measured, not yet built: the next detectors, in build order ───────────
  {
    dimension: 'file_churn  [next]',
    denominator: 'per file touched',
    probe: 'structural',
    confound:
      'the harness tracks a file from first touch, so a long session inflates versions; ' +
      'needs the p90 of 5 as a threshold rather than any absolute count',
    inCatalogue: false,
    // `file-history-snapshot` records a version per path regardless of HOW the
    // file changed — Edit, sed, an MCP server, a subagent. The one signal in
    // the format that is immune to the user's stack.
    count: (c) => {
      const versions = new Map<string, number>();
      for (const e of c.ev) {
        if (e.systemKind !== 'file-history') continue;
        for (const path of e.changedFiles ?? []) {
          versions.set(path, (versions.get(path) ?? 0) + 1);
        }
      }
      // p90 across the corpus is 5 versions; count the paths that exceed it.
      return [...versions.values()].filter((n) => n > 5).length;
    },
  },
  {
    dimension: 'context_reingest  [next]',
    denominator: 'per session',
    probe: 'structural',
    confound:
      'cache_creation/output is a session ratio with no turn to point at, so it is ' +
      'metadata until anchored to the turns where creation spiked',
    inCatalogue: false,
    // Exact, universal, and free of text: it describes the API call, not the
    // work, so it means the same thing for every language and every tool.
    // Measured p50 11.4, p90 83, p99 598 — a real long tail.
    count: (c) => {
      const d = countDenominators(c.ev);
      if (d.tokens.output === 0) return 0;
      return d.tokens.cacheCreation / d.tokens.output > 83 ? 1 : 0;
    },
  },
  {
    dimension: 'redundant_call  [next]',
    denominator: 'per tool call',
    probe: 'structural',
    confound:
      'a self-truncating command (`| head -30`) discards its own output upstream of us, ' +
      'so outHash compares a prefix; polling tools are excluded by name',
    inCatalogue: true,
    // Consecutive identical calls whose answers were also identical. The old
    // `tool_loop`, kept honest: the loose version of this probe said 4% of
    // sessions where the shipped detector found 0.4%.
    count: (c) => {
      const POLLING = new Set(['BashOutput', 'TaskOutput', 'Monitor', 'ListAgents']);
      let hits = 0;
      let runArgs: string | undefined;
      let runLen = 0;
      const outs: (string | undefined)[] = [];
      const flush = (): void => {
        if (runLen >= 3 && outs.length >= runLen && new Set(outs).size === 1 && !outs.includes(undefined)) {
          hits++;
        }
        runArgs = undefined;
        runLen = 0;
        outs.length = 0;
      };
      for (const e of c.ev) {
        if (e.turnType === 'tool_result') { outs.push(e.outHash); continue; }
        if (e.turnType === 'user_prompt') { flush(); continue; }
        if (e.turnType !== 'tool_use') continue;
        const sig = e.argHash === undefined ? undefined : `${e.toolName ?? '?'}|${e.argHash}`;
        if (sig === undefined || POLLING.has(e.toolName ?? '') || editEvidenceOf(e) === 'tool') { flush(); continue; }
        if (sig === runArgs) { runLen++; } else { flush(); runArgs = sig; runLen = 1; }
      }
      flush();
      return hits;
    },
  },

  // ── Structural, candidates with no detector yet ───────────────────────────
  {
    dimension: 'permission_denied',
    denominator: 'per tool call',
    probe: 'structural',
    confound:
      'declining is the person exercising control, not friction — frequent and now ' +
      'structurally visible via failureKind, but it is not obvious it should ever be surfaced',
    inCatalogue: true,
    // Structural at last. This was "needs a structural signal first" until the
    // parser started recording WHO rejected a call.
    count: (c) => c.ev.filter((e) => e.failureKind === 'denied' || e.failureKind === 'hook').length,
  },
  {
    dimension: 'reading_spiral',
    denominator: 'per session',
    probe: 'structural',
    confound: 'a parallel fan-out legitimately re-reads; sidechains are not excluded here',
    inCatalogue: true,
    count: (c) => {
      const reads = new Map<string, number>();
      let hits = 0;
      for (const e of c.ev) {
        if (editEvidenceOf(e) === 'tool') { reads.clear(); continue; }
        if (e.turnType !== 'tool_use' || !READ_TOOLS.has(e.toolName ?? '')) continue;
        if (e.filePath === undefined) continue;
        const n = (reads.get(e.filePath) ?? 0) + 1;
        reads.set(e.filePath, n);
        if (n === 3) hits++;
      }
      return hits;
    },
  },
];

async function main(): Promise<void> {
  const scratch = process.env['SCRATCH'] ?? '';
  const sessions = [
    ...loadSessions(join(scratch, 'setA'), 'A'),
    ...loadSessions(join(scratch, 'setB'), 'B'),
  ];
  if (sessions.length === 0) {
    console.error('no transcripts found; run pull-swechat.ts transcripts first');
    process.exit(1);
  }
  const labels = loadLabels(join(scratch, 'labels', 'turn-labels.jsonl'));

  const rows: Row[] = [];
  const denominators = {
    sessions: sessions.length,
    prompts: 0,
    edits: 0,
    toolCalls: 0,
    failures: 0,
    outputTokens: 0,
    cacheCreation: 0,
  };
  /** Which reason the harness gave, across every `edit_retry` instance. */
  const reasons = new Map<string, number>();
  /** cache_creation/output per session, for the percentiles that set the threshold. */
  const reingest: number[] = [];

  const perDim = new Map<string, { sessions: number; instances: number }>();
  const perSet = new Map<string, { A: number; B: number }>();
  for (const s of sessions) {
    const ev = [...s.events].sort((a, b) => a.seq - b.seq);
    const ctx: Ctx = {
      s,
      ev,
      prompts: ev.filter((e) => e.turnType === 'user_prompt'),
      edits: ev.filter((e) => editEvidenceOf(e) === 'tool'),
      toolCalls: ev.filter((e) => e.turnType === 'tool_use'),
    };
    const d = countDenominators(ev);
    denominators.prompts += ctx.prompts.length;
    denominators.edits += d.editCount;
    denominators.toolCalls += ctx.toolCalls.length;
    denominators.failures += ev.filter((e) => e.turnType === 'tool_result' && callFailed(e)).length;
    denominators.outputTokens += d.tokens.output;
    denominators.cacheCreation += d.tokens.cacheCreation;
    if (d.tokens.output > 0) reingest.push(d.tokens.cacheCreation / d.tokens.output);

    // What the harness said, per instance. The label tier is cosmetic by
    // design, so an unrecognised reason is counted rather than hidden.
    for (const hit of retriedFailures(ev)) {
      const r = reasonOf(hit.result) ?? '(unrecognised)';
      reasons.set(r, (reasons.get(r) ?? 0) + 1);
    }

    for (const p of PROBES) {
      let n = 0;
      try { n = p.count(ctx); } catch { n = 0; }
      const slot = perDim.get(p.dimension) ?? { sessions: 0, instances: 0 };
      if (n > 0) slot.sessions++;
      slot.instances += n;
      perDim.set(p.dimension, slot);
      const bySet = perSet.get(p.dimension) ?? { A: 0, B: 0 };
      if (n > 0) bySet[s.set]++;
      perSet.set(p.dimension, bySet);
    }
  }

  for (const p of PROBES) {
    const slot = perDim.get(p.dimension) ?? { sessions: 0, instances: 0 };
    rows.push({
      dimension: p.dimension,
      sessions: slot.sessions,
      instances: slot.instances,
      denominator: p.denominator,
      probe: p.probe,
      confound: p.confound,
      inCatalogue: p.inCatalogue,
    });
  }

  // ── SWE-chat's own labels, where they cover our sessions ──────────────────
  const ids = new Set(sessions.map((s) => s.id));
  const covered = [...labels.entries()].filter(([k]) => ids.has(k.split(':')[0] as string));
  const pushbackCounts = new Map<string, number>();
  for (const [, v] of covered) if (v.pushback) pushbackCounts.set(v.pushback, (pushbackCounts.get(v.pushback) ?? 0) + 1);

  console.log(`sessions measured: ${sessions.length}  (set A ${sessions.filter((s) => s.set === 'A').length}, set B ${sessions.filter((s) => s.set === 'B').length})`);
  console.log(`denominators: ${denominators.prompts} prompts · ${denominators.edits} edits · ${denominators.toolCalls} tool calls · ${denominators.failures} harness-declared failures`);
  const q = (xs: number[], p: number): string => {
    const sorted = [...xs].sort((a, b) => a - b);
    return (sorted[Math.floor(p * (sorted.length - 1))] ?? 0).toFixed(1);
  };
  console.log(
    `tokens: output ${denominators.outputTokens} · cache creation ${denominators.cacheCreation}`,
  );
  console.log(
    `cache_creation/output per session: p50 ${q(reingest, 0.5)} · p90 ${q(reingest, 0.9)} · ` +
      `p99 ${q(reingest, 0.99)}   (the ratio cache_read cannot give: see GRAVEYARD.md)`,
  );

  if (reasons.size > 0) {
    const tot = [...reasons.values()].reduce((a, b) => a + b, 0);
    console.log(`\nedit_retry — what the harness said, across ${tot} instances:`);
    for (const [k, v] of [...reasons].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(v).padStart(6)}  ${k}`);
    }
  }

  if (pushbackCounts.size > 0) {
    const tot = [...pushbackCounts.values()].reduce((a, b) => a + b, 0);
    console.log(`\nSWE-chat labels covering these sessions (${tot} annotated prompts):`);
    for (const [k, v] of [...pushbackCounts].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(v).padStart(6)}  ${k.padEnd(16)} ${((v / tot) * 100).toFixed(0)}%`);
    }
  }

  const nA = sessions.filter((s) => s.set === 'A').length;
  const nB = sessions.filter((s) => s.set === 'B').length;
  console.log('\n  all%   setA%  setB%  instances  dimension                      probe       catalogue');
  console.log('  (setA is friction-ANNOTATED and therefore biased; setB is the random control)');
  for (const r of rows.sort((a, b) => b.sessions - a.sessions || b.instances - a.instances)) {
    const bs = perSet.get(r.dimension) ?? { A: 0, B: 0 };
    const pct = (x: number, n: number) => (n === 0 ? '  -  ' : `${((x / n) * 100).toFixed(0).padStart(3)}%`);
    console.log(
      `  ${pct(r.sessions, sessions.length)}  ${pct(bs.A, nA)}  ${pct(bs.B, nB)}  ${String(r.instances).padStart(9)}  ${r.dimension.padEnd(30)} ${r.probe.padEnd(11)} ${r.inCatalogue ? 'yes' : 'NO'}`,
    );
  }
  console.log('\nconfounds (every number above is bounded by these):');
  for (const r of rows) console.log(`  ${r.dimension.padEnd(30)} ${r.confound}`);
}

if (import.meta.filename === process.argv[1]) await main();
