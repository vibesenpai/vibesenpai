/**
 * `redundant_call` — the same call, repeated, returning the same answer.
 *
 * `RULE+T` · conf `certain` (or `high`) · lower-is-better · standard
 *
 * ```
 * Bash: npx tsc --noEmit  → 30 lines
 * Bash: npx tsc --noEmit  → the same 30 lines
 * Bash: npx tsc --noEmit  → the same 30 lines
 * ```
 *
 * ── Kept on precision, not frequency ───────────────────────────────────────
 *
 * This fires on **0.4% of sessions** — 5 findings across 1,139. It earns its
 * place because all five survived hand-inspection: five identical typechecks
 * with nothing between them, four identical `TodoWrite`s, three identical greps.
 * A detector that is rare and never wrong is worth more than a frequent one
 * that needs defending, which is the lesson of everything in `GRAVEYARD.md`.
 *
 * It ships in `standard` rather than `core` for the same reason it is worth
 * having: at 0.4% it is not what a first-time reader should be shown first.
 *
 * ── Every guard here cost a false positive ─────────────────────────────────
 *
 * This is a rebuild of `tool_loop`, and the guards are not optional — each one
 * is a measured failure from its first life:
 *
 * 1. **Key on `argHash`**, the digest of the call's *full* arguments, never on
 *    `command`/`filePath`/`pattern`. Those three fields cover Bash, Read, Edit
 *    and Grep and nothing else, so comparing them produced 19 runs of which
 *    **16 were different calls that merely looked identical** — six separate
 *    tasks and seven separate subagents, all reported at `certain`.
 * 2. **The output must match too**, via `outHash` over the full normalised
 *    output and not `textSummary`: the summary caps at 200 characters and
 *    **59.9% of real results hit that cap**, so comparing summaries compared
 *    prefixes, and two different failures sharing an opening line looked equal.
 * 3. **A missing digest is not a match.** `outHash` is absent when output was
 *    empty or uncapturable, and `unknown` beats guessing.
 * 4. **Polling tools are not loops.** `BashOutput` returning `running` three
 *    times is identical output and correct use. This was the *only* finding the
 *    first version produced across 227 sessions, and it was wrong.
 * 5. **An argument-less call cannot be compared**, so it breaks the run rather
 *    than matching — assuming two such calls are the same was the most common
 *    false positive measured.
 * 6. **An edit breaks the run.** Something changed, so the next call is informed.
 * 7. **A new instruction breaks the run.** Whatever follows belongs to it.
 */

import { EDIT_TOOLS } from '../edits.ts';
import type { Candidate } from '../finding.ts';
import type { Confidence, StructuralEvent, TurnRef } from '../types.ts';
import type { Detector, DetectorContext } from './types.ts';

export const DEFAULT_MIN_REPEATS = 3;

/**
 * Tools whose whole purpose is to report current state.
 *
 * A closed, harness-owned list — the kind D31 permits — and distinct from the
 * output-identity guard: a poll that keeps returning `running` *is* identical
 * output, so only the tool's semantics separate it from a genuine loop.
 */
export const POLLING_TOOLS = new Set(['BashOutput', 'TaskOutput', 'Monitor', 'ListAgents']);

/** What makes two calls the same call. Undefined when they cannot be compared. */
export function signatureOf(e: StructuralEvent): string | undefined {
  if (e.turnType !== 'tool_use') return undefined;
  if (e.argHash === undefined) return undefined;
  return `${e.toolName ?? 'unknown'}|${e.argHash}`;
}

type Run = {
  signature: string;
  calls: StructuralEvent[];
  outputs: (string | undefined)[];
  /** Any call in the run clipped its own output before we saw it. */
  truncated: boolean;
};

/** Group a span's events into runs of consecutive identical calls. */
export function runsOf(events: StructuralEvent[]): Run[] {
  const runs: Run[] = [];
  let current: Run | undefined;

  const flush = (): void => {
    if (current !== undefined && current.calls.length > 1) runs.push(current);
    current = undefined;
  };

  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    switch (e.turnType) {
      case 'tool_use': {
        // An edit means state changed, so a repeat after it is informed — that
        // is the `fail_fix_fail` shape, not a loop.
        if (EDIT_TOOLS.has(e.toolName ?? '') || POLLING_TOOLS.has(e.toolName ?? '')) {
          flush();
          break;
        }
        const sig = signatureOf(e);
        if (sig === undefined) {
          flush();
          break;
        }
        if (current !== undefined && current.signature === sig) {
          current.calls.push(e);
          if (e.truncatesOwnOutput === true) current.truncated = true;
        } else {
          flush();
          current = {
            signature: sig,
            calls: [e],
            outputs: [],
            truncated: e.truncatesOwnOutput === true,
          };
        }
        break;
      }

      // Recorded, not a break: the answers are how we tell a loop from a
      // sequence that was learning something.
      case 'tool_result':
        if (current !== undefined) current.outputs.push(e.outHash);
        break;

      // Prose between retries is not a state change. "Let me try that again"
      // does not make the second attempt informed.
      case 'assistant_msg':
        break;

      case 'user_prompt':
        flush();
        break;

      default:
        break;
    }
  }
  flush();
  return runs;
}

/**
 * Did every call in the run come back the same?
 *
 * Identical output, not merely "not all different" — the weaker test fired on
 * `[FAIL, FAIL, OK]`, a run whose last call plainly returned something new.
 */
export function sameAnswerThroughout(outputs: (string | undefined)[], calls: number): boolean {
  if (outputs.length < calls) return false; // a result we never saw
  if (outputs.some((o) => o === undefined)) return false; // nothing to compare
  return new Set(outputs).size === 1;
}

export type RedundantCallOptions = { minRepeats?: number };

export function redundantCall(opts: RedundantCallOptions = {}): Detector {
  const minRepeats = opts.minRepeats ?? DEFAULT_MIN_REPEATS;

  return {
    dimension: 'redundant_call',
    // Thread, not session: another actor's call spliced between two identical
    // ones makes them non-consecutive, and a subagent's repeats are its own.
    scope: 'thread',
    polarity: 'lower-is-better',
    confidence: 'certain',
    method: 'RULE+T',
    requiresOutcome: false,
    denominator: 'per-tool-call',
    preset: 'standard',

    describe(subject, occurrences) {
      return `${subject} ran ${occurrences}× with nothing changed and the same answer`;
    },

    async detect(ctx: DetectorContext): Promise<Candidate[]> {
      const out: Candidate[] = [];

      for (const run of runsOf(ctx.events)) {
        if (run.calls.length < minRepeats) continue;
        if (!sameAnswerThroughout(run.outputs, run.calls.length)) continue;

        // A clipped output means the digest compared a prefix, so "the same
        // answer" is a weaker claim. Downgraded rather than dropped: the
        // structural facts — consecutive, identical arguments, nothing between
        // — all still hold.
        const confidence: Confidence = run.truncated ? 'high' : 'certain';

        const evidence: TurnRef[] = run.calls.map((e) => ({
          uuid: e.uuid,
          sessionId: e.sessionId,
          seq: e.seq,
        }));

        out.push({
          dimension: 'redundant_call',
          subject: subjectOf(run.calls[0] as StructuralEvent),
          evidence,
          confidence,
          method: 'RULE+T',
          polarity: 'lower-is-better',
          requiresOutcome: false,
          artifacts: [],
        });
      }

      return out;
    },
  };
}

/**
 * How the repeated call is named.
 *
 * The digest is identity, not language, and a detector cannot read the command
 * — so where no readable target exists the subject is the tool plus a short
 * digest. Opaque but stable, and `now` prints the turns, which is where the
 * detail belongs.
 */
export function subjectOf(e: StructuralEvent): string {
  const tool = e.toolName ?? 'unknown';
  if (e.filePath !== undefined && e.filePath.trim() !== '') return `${tool} ${e.filePath}`;
  return `${tool} #${(e.argHash ?? '').slice(0, 6)}`;
}
