/**
 * `tool_loop` — identical tool calls repeated with no new information.
 *
 * `RULE+T` · conf `certain` · lower-is-better · core
 *
 * ```
 * Bash: npm test → FAIL
 * Bash: npm test → FAIL      (identical command, nothing changed between)
 * Bash: npm test → FAIL
 * ```
 *
 * ── Why this is `certain` ────────────────────────────────────────────────────
 *
 * We are not judging whether repeating the call was reasonable. We observe that
 * the same call was made N times consecutively with no state change between —
 * which is structural, and checkable from the transcript alone.
 *
 * ── The false positive this is built around ──────────────────────────────────
 *
 * Legitimate polling: waiting on a build, a deploy, a flaky network call. The
 * spec's mitigation is "no intervening state change", which does not help, since
 * polling has none either. So there are two further guards:
 *
 *   1. **Distinct results mean new information.** If every call in the run came
 *      back different, the caller was learning something and this is not a loop.
 *      A progress spinner, a growing log, a changing status all land here.
 *   2. **N is configurable**, because a retry-with-backoff is indistinguishable
 *      from a loop by structure alone and some projects do it legitimately.
 */

import type { Candidate } from '../finding.ts';
import type { Event, TurnRef } from '../types.ts';
import type { Detector, DetectorContext } from './types.ts';

/** Tool calls that change state, so a run cannot continue across them. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Tools whose whole purpose is to check current state.
 *
 * Calling `BashOutput` three times on a running job is not a loop — it is how
 * the tool is meant to be used, and the answer legitimately changes between
 * calls even when the text does not. This was the only `tool_loop` finding the
 * detector produced across 227 real sessions, and it was wrong.
 *
 * Distinct from the result-distinctness guard: a poll that keeps returning
 * `running` is *identical* output, so only the tool's semantics separate it from
 * a genuine loop.
 */
const POLLING_TOOLS = new Set(['BashOutput', 'TaskOutput', 'Monitor', 'ListAgents']);

export const DEFAULT_MIN_REPEATS = 3;

/**
 * What makes two calls "the same call".
 *
 * Keyed on `argHash` — the digest of the call's **full** arguments — not on the
 * human-readable target. Measured on 227 sessions: comparing only
 * `command`/`filePath`/`pattern` produced 19 repeated-call runs of which **16
 * were different calls that merely looked identical**, because those three
 * fields cover Bash, Read, Edit and Grep and nothing else. Six separate tasks
 * and seven separate subagents would have been reported at `certain` confidence.
 *
 * Returns undefined when there is no digest, which means the call took no
 * arguments. Two such calls are indistinguishable *to us*, and CLAUDE.md is
 * explicit that `unknown` beats guessing — so the caller skips them rather than
 * assuming they are the same.
 */
export function signatureOf(e: Event): string | undefined {
  if (e.turnType !== 'tool_use') return undefined;
  if (e.argHash === undefined) return undefined;
  return `${e.toolName ?? 'unknown'}|${e.argHash}`;
}

/**
 * How the repeated call is named in the finding.
 *
 * The digest is identity, not language. Where a readable target exists it is
 * used; otherwise the subject falls back to the tool plus a short digest, which
 * is opaque but stable — and `explain` prints the window, which is where the
 * detail actually belongs.
 */
export function subjectOf(e: Event): string {
  const tool = e.toolName ?? 'unknown';
  const readable = e.command ?? e.filePath ?? e.pattern;
  if (readable !== undefined && readable.trim() !== '') {
    return `${tool} ${readable.replace(/\s+/g, ' ').trim()}`;
  }
  return `${tool} #${(e.argHash ?? '').slice(0, 6)}`;
}

/**
 * Strip the volatile parts of a result so two runs of the same failing test
 * compare equal.
 *
 * Without this the distinctness guard below never fires: real output carries
 * durations, line numbers and ids that differ every run, so *every* repeat looks
 * like new information. Measured: 0 of 19 runs survived the un-normalised guard.
 * Same approach the spec prescribes for `fail_fix_fail`'s error signature, so
 * flaky line numbers do not split one failure into three.
 */
export function normaliseResult(text: string | undefined): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,}\b/g, 'H')
    .replace(/\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds|m|min)\b/g, 'D')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

type Run = { signature: string; events: Event[]; results: (string | undefined)[] };

/** Group a window's events into runs of consecutive identical calls. */
export function runsOf(events: Event[]): Run[] {
  const runs: Run[] = [];
  let current: Run | undefined;

  const flush = (): void => {
    if (current !== undefined && current.events.length > 1) runs.push(current);
    current = undefined;
  };

  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    switch (e.turnType) {
      case 'tool_use': {
        // An edit between two identical commands is the `fail_fix_fail` shape,
        // not a loop — something changed, so the retry was informed.
        if (EDIT_TOOLS.has(e.toolName ?? '')) {
          flush();
          break;
        }
        if (POLLING_TOOLS.has(e.toolName ?? '')) {
          flush();
          break;
        }
        const sig = signatureOf(e);
        if (sig === undefined) {
          // No arguments to compare. Treated as a break rather than a match:
          // assuming two argument-less calls are the same call is the false
          // positive this detector was measured to produce most.
          flush();
          break;
        }
        if (current !== undefined && current.signature === sig) {
          current.events.push(e);
        } else {
          flush();
          current = { signature: sig, events: [e], results: [] };
        }
        break;
      }

      case 'tool_result':
        // The result of the call being repeated. Recorded, not a break: it is
        // how we tell a loop from a sequence that was learning something.
        if (current !== undefined) current.results.push(e.textSummary);
        break;

      case 'assistant_msg':
        // Prose between retries is not a state change. "Let me try that again"
        // does not make the second attempt informed.
        break;

      case 'user_prompt':
        // New instruction, new context. Whatever follows is a fresh attempt.
        flush();
        break;

      default:
        break;
    }
  }
  flush();
  return runs;
}

/** True when every result in the run differs — the caller was learning. */
function resultsAllDistinct(results: (string | undefined)[]): boolean {
  const present = results.filter((r) => r !== undefined).map(normaliseResult);
  if (present.length < 2) return false;
  return new Set(present).size === present.length;
}

export type ToolLoopOptions = { minRepeats?: number };

export function toolLoop(opts: ToolLoopOptions = {}): Detector {
  const minRepeats = opts.minRepeats ?? DEFAULT_MIN_REPEATS;

  return {
    dimension: 'tool_loop',
    polarity: 'lower-is-better',
    confidence: 'certain',
    method: 'RULE+T',
    requiresOutcome: false,
    denominator: 'per-session',
    preset: 'core',

    describe(subject, occurrences) {
      return `${subject} repeated ${occurrences}× with nothing changed in between`;
    },

    async detect(ctx: DetectorContext): Promise<Candidate[]> {
      const out: Candidate[] = [];

      for (const run of runsOf(ctx.window.events)) {
        if (run.events.length < minRepeats) continue;
        if (resultsAllDistinct(run.results)) continue;

        const evidence: TurnRef[] = run.events.map((e) => ({
          uuid: e.uuid,
          sessionId: e.sessionId,
          seq: e.seq,
        }));

        out.push({
          dimension: 'tool_loop',
          subject: subjectOf(run.events[0] as Event),
          evidence,
          confidence: 'certain',
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
