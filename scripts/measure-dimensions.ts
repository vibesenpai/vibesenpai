/**
 * How often does each dimension actually occur?
 *
 * This exists because three detectors shipped and produced **0 findings across
 * 255 real sessions**. Rather than build a fourth from the catalogue's assumed
 * order, measure the order.
 *
 * ── Rules this script holds itself to ───────────────────────────────────────
 *
 * 1. **Every number carries its denominator.** "23 corrections" means nothing;
 *    "23 of 180 prompts" does.
 * 2. **Every probe declares whether it is structural or lexical.** A lexical
 *    probe is a nominator and its count is an upper bound, never a measurement.
 *    This session produced probes wrong by 3x in both directions — 234 "ignored
 *    errors" that were mostly the agent investigating, 56 "unverified edits" of
 *    which 2 were real — and both looked authoritative until broken down.
 * 3. **Every probe states its confound**, in the table, next to the number.
 * 4. **Where SWE-chat has a label, the label wins.** `prompt_pushback` is
 *    annotated on 201,485 prompts and validated in the paper; our regex is not
 *    evidence against it.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from '../src/parsers/index.ts';
import { learn, lookupFor, emptyRegistry, resultFailed, type VerificationRegistry } from '../src/verify.ts';
import { editEvidenceOf, EDIT_TOOLS, READ_TOOLS } from '../src/edits.ts';
import { runsOf } from '../src/detect/tool-loop.ts';
import { destructiveKind } from '../src/detect/revert-churn.ts';
import { isSuccessClaim } from '../src/detect/claims.ts';
import { executablePart } from '../src/detect/command.ts';
import type { Event } from '../src/types.ts';

type Probe = 'structural' | 'lexical' | 'labelled';

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
  reg: VerificationRegistry;
  prompts: Event[];
  edits: Event[];
  toolCalls: Event[];
  bash: Event[];
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
  // ── A. Looping ────────────────────────────────────────────────────────────
  {
    dimension: 'tool_loop',
    denominator: 'per session',
    probe: 'structural',
    confound: 'needs argHash AND identical outHash; a piped command masks its own output',
    inCatalogue: true,
    count: (c) => runsOf(c.ev).filter((r) => r.events.length >= 3).length,
  },
  {
    dimension: 'reading_spiral',
    denominator: 'per session',
    probe: 'structural',
    confound: 'a parallel fan-out legitimately re-reads; sidechains are not excluded here',
    inCatalogue: true,
    count: (c) => {
      const reads = new Map<string, number>();
      let edited = false;
      let hits = 0;
      for (const e of c.ev) {
        if (editEvidenceOf(e) === 'tool') { edited = true; reads.clear(); continue; }
        if (e.turnType !== 'tool_use' || !READ_TOOLS.has(e.toolName ?? '')) continue;
        if (e.filePath === undefined) continue;
        const n = (reads.get(e.filePath) ?? 0) + 1;
        reads.set(e.filePath, n);
        if (n === 4) hits++; // 4+ reads of one file with no edit between
      }
      void edited;
      return hits;
    },
  },
  {
    dimension: 'revert_churn',
    denominator: 'per session',
    probe: 'structural',
    confound: 'discarding a deliberate spike is good engineering; neutral by design',
    inCatalogue: true,
    count: (c) =>
      c.edits.length === 0 ? 0 : c.ev.filter((e) => destructiveKind(e.command) !== undefined).length,
  },
  {
    dimension: 'fail_fix_fail',
    denominator: 'per session',
    probe: 'structural',
    confound: 'needs a failing verification; 95% of results carry no exit signal',
    inCatalogue: true,
    count: (c) => {
      const look = lookupFor(c.reg, c.s.project, { requireConfirmed: false });
      let fails = 0;
      let editsBetween = 0;
      let hits = 0;
      let lastCall: Event | undefined;
      for (const e of c.ev) {
        if (editEvidenceOf(e) === 'tool') { editsBetween++; continue; }
        if (e.turnType === 'tool_use') { lastCall = e; continue; }
        if (e.turnType !== 'tool_result') continue;
        if (!look.isVerification(lastCall?.command)) continue;
        if (resultFailed(e)) { fails++; if (fails >= 3 && editsBetween >= 2) { hits++; fails = 0; editsBetween = 0; } }
        else { fails = 0; editsBetween = 0; }
      }
      return hits;
    },
  },

  // ── D. Honesty ────────────────────────────────────────────────────────────
  {
    dimension: 'inaccurate_self_report',
    denominator: 'per success claim',
    probe: 'lexical',
    confound: 'claim detection is lexical over an open space; needs a confirmed verification failure',
    inCatalogue: true,
    count: (c) => {
      const look = lookupFor(c.reg, c.s.project, { requireConfirmed: false });
      let lastFail: Event | undefined;
      let lastCall: Event | undefined;
      let hits = 0;
      for (const e of c.ev) {
        if (e.turnType === 'user_prompt') { lastFail = undefined; continue; }
        if (e.turnType === 'tool_use') { lastCall = e; continue; }
        if (e.turnType === 'tool_result') {
          lastFail = resultFailed(e) && look.isVerification(lastCall?.command) ? e : undefined;
          continue;
        }
        if (e.turnType === 'assistant_msg' && e.textSummary && lastFail) {
          if (isSuccessClaim(e.textSummary)) { hits++; lastFail = undefined; }
        }
      }
      return hits;
    },
  },
  {
    dimension: 'scope_overreach',
    denominator: 'per session',
    probe: 'structural',
    confound: 'wide edits may be genuinely necessary; no acceptance signal is checked',
    inCatalogue: true,
    count: (c) => {
      const files = new Set(c.edits.map((e) => e.filePath).filter(Boolean));
      // A proxy, deliberately crude: one prompt, many files touched.
      return c.prompts.length === 1 && files.size >= 5 ? 1 : 0;
    },
  },

  // ── E. User friction ──────────────────────────────────────────────────────
  {
    dimension: 'user_interrupt',
    denominator: 'per prompt',
    probe: 'structural',
    confound: 'interrupting to ADD information is steering, not friction; counts enqueue only',
    inCatalogue: true,
    // `enqueue` is the user typing while the agent works. The matching `dequeue`
    // is the same prompt being delivered, so counting every queue_operation
    // triple-counted one interaction — the first version reported 19,501.
    count: (c) => c.ev.filter((e) => e.queueOpSubtype === 'enqueue').length,
  },
  {
    dimension: 'prompt_withdrawn  [NEW]',
    denominator: 'per prompt',
    probe: 'structural',
    confound: 'a withdrawn prompt may be a typo rather than a change of mind',
    inCatalogue: false,
    // `remove`/`popAll` is a queued prompt the user took back — they typed it,
    // then thought better of it. SWE-chat annotates the same thing as
    // `user_prompt_discarded` (18,638 across the dataset).
    count: (c) =>
      c.ev.filter((e) => e.queueOpSubtype === 'remove' || e.queueOpSubtype === 'popAll').length,
  },

  // ── G. Verification ───────────────────────────────────────────────────────
  {
    dimension: 'no_verification',
    denominator: 'per edit',
    probe: 'structural',
    confound: 'silent unless the project is warm; verification may have happened outside the session',
    inCatalogue: true,
    count: (c) => {
      const look = lookupFor(c.reg, c.s.project);
      if (look.cold) return 0;
      let pending = 0;
      let unverified = 0;
      for (const e of c.ev) {
        const evd = editEvidenceOf(e);
        if (evd === 'tool' || evd === 'harness') pending++;
        else if (e.turnType === 'tool_use' && look.isVerification(e.command)) pending = 0;
      }
      unverified = pending;
      return unverified;
    },
  },
  {
    dimension: 'error_ignored',
    denominator: 'per failure',
    probe: 'structural',
    confound:
      'OVER-COUNTS badly: measured 234 of which >=68 were the agent fixing or re-checking, 55 more investigating',
    inCatalogue: true,
    count: (c) => {
      let hits = 0;
      for (const [i, e] of c.ev.entries()) {
        if (e.turnType !== 'tool_result' || !resultFailed(e)) continue;
        const next = c.ev.slice(i + 1).find((x) => x.turnType === 'tool_use');
        if (next === undefined) continue;
        const addressed =
          editEvidenceOf(next) !== undefined || READ_TOOLS.has(next.toolName ?? '');
        if (!addressed) hits++;
      }
      return hits;
    },
  },
  {
    dimension: 'premature_external_write',
    denominator: 'per session',
    probe: 'structural',
    confound: 'pushing to a personal branch where CI verifies is normal; no branch awareness',
    inCatalogue: true,
    count: (c) => {
      const look = lookupFor(c.reg, c.s.project, { requireConfirmed: false });
      let verifiedSinceEdit = false;
      let hits = 0;
      for (const e of c.ev) {
        if (editEvidenceOf(e) === 'tool') verifiedSinceEdit = false;
        if (e.turnType === 'tool_use' && look.isVerification(e.command)) verifiedSinceEdit = true;
        if (e.turnType !== 'tool_use' || e.command === undefined) continue;
        if (!/\bgit\s+push\b|\bnpm\s+publish\b|\bgh\s+pr\s+create\b/.test(executablePart(e.command))) continue;
        // Only a push with NO verification since the last edit is premature.
        // Counting every push reported 3,634, which is just "people push".
        if (!verifiedSinceEdit) hits++;
      }
      return hits;
    },
  },

  // ── F. Healthy ────────────────────────────────────────────────────────────
  {
    dimension: 'tdd_fail_then_pass',
    denominator: 'per session',
    probe: 'structural',
    confound: 'needs a verification verdict on both sides; masked exit status hides most',
    inCatalogue: true,
    count: (c) => {
      const look = lookupFor(c.reg, c.s.project, { requireConfirmed: false });
      let testEdited = false;
      let sawFail = false;
      let hits = 0;
      let lastCall: Event | undefined;
      for (const e of c.ev) {
        if (editEvidenceOf(e) === 'tool' && /test|spec/i.test(e.filePath ?? '')) testEdited = true;
        if (e.turnType === 'tool_use') { lastCall = e; continue; }
        if (e.turnType !== 'tool_result' || !look.isVerification(lastCall?.command)) continue;
        if (resultFailed(e)) { if (testEdited) sawFail = true; }
        else if (sawFail) { hits++; sawFail = false; testEdited = false; }
      }
      return hits;
    },
  },

  // ── Candidates the catalogue does NOT have ────────────────────────────────
  {
    dimension: 'edit_retry_friction  [NEW]',
    denominator: 'per edit',
    probe: 'structural',
    confound: 'a user declining the edit is counted separately; retry window is 14 events',
    inCatalogue: false,
    count: (c) => {
      let hits = 0;
      for (const [i, e] of c.ev.entries()) {
        if (e.turnType !== 'tool_use' || !EDIT_TOOLS.has(e.toolName ?? '')) continue;
        const res = c.ev.slice(i + 1, i + 4).find((x) => x.turnType === 'tool_result');
        if (res === undefined || !resultFailed(res)) continue;
        if (/doesn't want to proceed|rejected/i.test(res.textSummary ?? '')) continue;
        const retried = c.ev
          .slice(i + 1, i + 15)
          .some((x) => x.turnType === 'tool_use' && EDIT_TOOLS.has(x.toolName ?? '') && x.filePath === e.filePath);
        if (retried) hits++;
      }
      return hits;
    },
  },
  {
    dimension: 'permission_friction  [NEW]',
    denominator: 'per tool call',
    probe: 'structural',
    confound: 'declining a tool call is the user exercising control, not necessarily friction',
    inCatalogue: false,
    count: (c) =>
      c.ev.filter(
        (e) =>
          e.turnType === 'tool_result' &&
          /doesn't want to proceed|tool use was rejected|user rejected/i.test(e.textSummary ?? ''),
      ).length,
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

  // Learn verification across every session first, exactly as the product does.
  let reg = emptyRegistry();
  for (const s of sessions) reg = learn(reg, s.events, s.project, 'measure');

  const rows: Row[] = [];
  const denominators = { sessions: sessions.length, prompts: 0, edits: 0, toolCalls: 0, failures: 0, claims: 0 };

  const perDim = new Map<string, { sessions: number; instances: number }>();
  const perSet = new Map<string, { A: number; B: number }>();
  for (const s of sessions) {
    const ev = [...s.events].sort((a, b) => a.seq - b.seq);
    const ctx: Ctx = {
      s,
      ev,
      reg,
      prompts: ev.filter((e) => e.turnType === 'user_prompt'),
      edits: ev.filter((e) => editEvidenceOf(e) === 'tool'),
      toolCalls: ev.filter((e) => e.turnType === 'tool_use'),
      bash: ev.filter((e) => e.turnType === 'tool_use' && e.command !== undefined),
    };
    denominators.prompts += ctx.prompts.length;
    denominators.edits += ctx.edits.length;
    denominators.toolCalls += ctx.toolCalls.length;
    denominators.failures += ev.filter((e) => e.turnType === 'tool_result' && resultFailed(e)).length;
    denominators.claims += ev.filter(
      (e) => e.turnType === 'assistant_msg' && e.textSummary !== undefined && isSuccessClaim(e.textSummary),
    ).length;

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
  console.log(`denominators: ${denominators.prompts} prompts · ${denominators.edits} edits · ${denominators.toolCalls} tool calls · ${denominators.failures} failures · ${denominators.claims} claims`);
  console.log(`verification learned: ${Object.keys(reg.entries).length} commands, ${new Set(sessions.map((s) => s.project)).size} projects`);
  console.log(`warm sessions: ${sessions.filter((s) => !lookupFor(reg, s.project).cold).length}`);

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
