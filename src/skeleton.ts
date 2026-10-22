/**
 * The skeletonizer: `Event[]` → windows → `Skeleton[]`.
 *
 * A skeleton is the unit everything downstream works on, and it has three
 * consumers at once (docs/contracts.md §3): model input at ~2K tokens, the
 * evidence `explain` prints, and the future team product's wire format. One
 * typed structure, two renderings.
 *
 * ── What a "turn" is, since the spec reads two ways ───────────────────────────
 *
 * "6–12 turn sliding windows" could mean 6–12 events or 6–12 exchanges. The
 * rendered example in docs/contracts.md settles it: seven lines containing two
 * user prompts, with each tool call on its own line. So a **turn is a skeleton
 * line**, and a window is 6–12 of them. An exchange-based window would be an
 * order of magnitude larger and would blow the token budget on every real
 * session.
 *
 * ── Why windows do not overlap by default ────────────────────────────────────
 *
 * `Finding` identity is subject-based (`hash(dimension + project + subject)`),
 * never evidence extent, so the same finding surfacing from two windows merges
 * rather than duplicating.
 *
 * **The double-counting objection is resolved.** This used to say `occurrences`
 * would double-count a turn seen twice "until M2a's evidence-set merge exists".
 * It exists — see `src/finding.ts`: `occurrences` is the number of **distinct
 * anchors**, so merging two windows that share a turn counts it once and the
 * number describes the session rather than the slicing.
 *
 * Non-overlapping therefore remains the default on its own merits rather than
 * as a workaround: it can only cause a missed pattern that straddles a
 * boundary, and CLAUDE.md is explicit that thresholds are tuned to miss rather
 * than over-fire. `stride` is a parameter, so lowering it is now genuinely safe
 * — a one-line change, not a redesign.
 */

import { executablePart } from './command.ts';
import { stamp } from './schema.ts';
import type { Event, Skeleton, SkeletonLine, TurnRef } from './types.ts';

export type SkeletonOptions = {
  /** Lines per window. The spec's 6–12; 12 is the upper bound, not a target. */
  width?: number;
  /** Lines advanced between windows. Defaults to `width` — no overlap. */
  stride?: number;
  /**
   * Token ceiling per window. 2K leaves room for a rubric and examples inside a
   * 4K prompt.
   */
  tokenBudget?: number;
};

const DEFAULTS = { width: 12, stride: undefined, tokenBudget: 2000 } as const;

/**
 * Rough token estimate: 4 characters per token.
 *
 * Deliberately not a real tokenizer. Shipping one would add a runtime
 * dependency and a model-specific vocabulary to a budget that only needs to be
 * approximately right — and the budget is a *ceiling*, so erring high costs a
 * little extra elision while erring low would overflow a prompt.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Git operations worth promoting out of a plain tool line.
 *
 * Display tier: this reads command text, which no *detector* may do. It marks a
 * skeleton line so the token budget keeps it and a human reading the evidence
 * sees where a commit or a revert landed. It produces no finding, so a wrong
 * label is visible and harmless — see `src/command.ts`.
 */
function gitMeta(command: string | undefined): 'commit' | 'revert' | undefined {
  if (command === undefined) return undefined;
  // A doc file mentioning `git commit` would otherwise render as a commit that
  // never happened.
  const exec = executablePart(command);
  if (/\bgit\s+(?:-\S+\s+)*commit\b/.test(exec)) return 'commit';
  if (/\bgit\s+(?:revert|reset\s+--hard)\b|\bgit\s+checkout\s+--/.test(exec)) return 'revert';
  return undefined;
}

function refOf(e: Event): TurnRef {
  return { uuid: e.uuid, sessionId: e.sessionId, seq: e.seq };
}

/**
 * Enough of a shell command to tell two invocations apart.
 *
 * Two words was too few: it collapsed 111 distinct `uv run <script>` calls into
 * one indistinguishable target, which is precisely the discrimination a detector
 * needs. Leading shell punctuation is stripped because a compound command
 * otherwise yields targets like `(source .venv/bin/activate`.
 *
 * Capped by characters rather than words, and cut on a word boundary. The
 * command has already been redacted upstream, so the only concern here is
 * length — and the token budget has 4x headroom at the worst real window.
 */
function commandHead(command: string, max = 48): string {
  const cleaned = command.trim().replace(/^[([{;&|\s]+/, '');
  const firstLine = cleaned.split('\n')[0] ?? '';
  if (firstLine.length <= max) return firstLine;
  const cut = firstLine.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function targetOf(e: Event): string | undefined {
  if (e.filePath !== undefined) return e.filePath;
  if (e.pattern !== undefined) return e.pattern;
  if (e.command !== undefined) return commandHead(e.command);
  return undefined;
}

export type LineResult = {
  lines: SkeletonLine[];
  /** Thread total — every type with no line representation, counted. */
  dropped: Record<string, number>;
  /**
   * The same drops, located: `dropsAt[i]` holds what was dropped immediately
   * before line `i`, with a trailing bucket at `lines.length`.
   *
   * A window must report only the drops inside its own span. Stamping the thread
   * total onto every window would multiply the count by the number of windows,
   * which defeats the reason the field exists — a compression ratio must not be
   * flattered by quietly discarding input, and it would be *worse* than flattered
   * if the discard count were inflated tenfold.
   */
  dropsAt: Record<string, number>[];
};

/**
 * Events → lines.
 *
 * The compression comes from two moves: a successful `tool_result` is omitted
 * entirely (the tool line already says the call happened), and assistant prose
 * is summarised rather than reproduced. A *failed* result always gets its own
 * line — failure is the signal almost every detector is built on, and dropping
 * it would be compressing out the evidence itself.
 */
export function toLines(events: Event[]): LineResult {
  const lines: SkeletonLine[] = [];
  const dropped: Record<string, number> = {};
  const dropsAt: Record<string, number>[] = [];
  let pending: Record<string, number> = {};

  const drop = (k: string): void => {
    dropped[k] = (dropped[k] ?? 0) + 1;
    pending[k] = (pending[k] ?? 0) + 1;
  };
  /** Attach whatever was dropped since the previous line, then start fresh. */
  const seal = (): void => {
    dropsAt.push(pending);
    pending = {};
  };
  const emit = (l: SkeletonLine): void => {
    lines.push(l);
    seal();
  };

  for (const e of events) {
    const ref = refOf(e);
    const flag = e.abandoned === true ? ({ abandoned: true } as const) : {};

    switch (e.turnType) {
      case 'user_prompt':
        emit({ k: 'user', ref, text: e.textSummary ?? '', ...flag });
        break;

      case 'assistant_msg':
        // An assistant record with no text carries nothing: it renders as a bare
        // `A  …`, and any tool calls it contained already have their own lines.
        // Measured: 3.8% of lines on the public corpus, but 21.3% on a
        // tool-heavy real session — pure cost in all three consumers, worst in
        // the one with a token budget.
        if (e.textSummary === undefined) {
          drop('assistant_msg:no-text');
          break;
        }
        emit({ k: 'assist', ref, text: e.textSummary, ...flag });
        break;

      case 'tool_use': {
        // A commit or a revert is an outcome signal, not a tool invocation, and
        // outcome classification is the thing most starved of input. Promoting
        // it also makes those two `meta` kinds reachable.
        const git = gitMeta(e.command);
        if (git !== undefined) {
          emit({ k: 'meta', ref, kind: git, ...flag });
          break;
        }
        emit({
          k: 'tool',
          ref,
          tool: e.toolName ?? 'unknown',
          ...(targetOf(e) !== undefined ? { target: targetOf(e) as string } : {}),
          ...flag,
        });
        break;
      }

      case 'tool_result': {
        const failed = e.isError === true || (e.exitCode !== undefined && e.exitCode !== 0);
        if (!failed) {
          // Not emitted: a read that worked says nothing a detector needs, and
          // the preceding tool line already records that the call happened.
          // Note this is *omission*, not a merge — nothing is written back onto
          // the tool line, so the contract's `→ Edit auth.ts (60 lines)` example
          // is not reproducible until `lines` has a source. `Event` carries no
          // edit size today.
          break;
        }
        emit({
          k: 'result',
          ref,
          ok: false,
          ...(e.textSummary !== undefined ? { err: e.textSummary } : {}),
          ...flag,
        });
        break;
      }

      case 'queue_operation':
        emit({ k: 'meta', ref, kind: 'interrupt', ...flag });
        break;

      case 'system':
        if (e.systemKind === 'compaction') {
          emit({ k: 'meta', ref, kind: 'compaction', ...flag });
          break;
        }
        drop(`system:${e.systemKind ?? 'other'}`);
        break;

      case 'local_command':
        // Not a human speaking. Counting it as a prompt would inflate every
        // per-prompt denominator; see TurnType in types.ts.
        drop('local_command');
        break;

      default:
        drop(e.turnType);
    }
  }

  // Trailing bucket: anything dropped after the last line.
  dropsAt.push(pending);

  return { lines, dropped, dropsAt };
}

/** One line of the text rendering. Shared by the model prompt and `explain`. */
function renderLine(l: SkeletonLine): string {
  const mark = l.abandoned === true ? '  [abandoned]' : '';
  switch (l.k) {
    case 'user':
      return `U  ${l.text}${mark}`;
    case 'assist':
      return `A  ${l.text ?? '…'}${mark}`;
    case 'tool':
      return `→  ${l.tool}${l.target !== undefined ? ` ${l.target}` : ''}` +
        `${l.lines !== undefined ? ` (${l.lines} lines)` : ''}${mark}`;
    case 'result':
      return `✗  ${l.err ?? 'failed'}${l.failures !== undefined ? ` (${l.failures})` : ''}${mark}`;
    case 'meta':
      return `~  ${l.kind}${mark}`;
  }
}

/**
 * The text rendering, for models and humans alike.
 *
 * Elision is printed, never silent. A skeleton that quietly dropped the
 * decisive turn would produce a confident wrong verdict, which is the single
 * most expensive failure this design can have.
 */
export function render(sk: Skeleton): string {
  const body = sk.lines.map(renderLine).join('\n');
  if (sk.elided === undefined) return body;
  return `${body}\n…  ${sk.elided.lines} line(s) shortened or dropped (${sk.elided.reason})`;
}

/**
 * Bring a window under its token ceiling.
 *
 * Dropped by rule, worst-value first: assistant prose, then assistant lines
 * entirely, then tool targets. User prompts, failures and meta lines are never
 * dropped — they are what the detectors read. If a window is still over budget
 * after all three passes it is emitted over budget rather than gutted: an
 * honest overflow beats a skeleton missing its evidence.
 */
function fitToBudget(
  lines: SkeletonLine[],
  budget: number,
): { lines: SkeletonLine[]; elided?: { lines: number; reason: 'token-budget' } } {
  const cost = (ls: SkeletonLine[]): number => estimateTokens(ls.map(renderLine).join('\n'));
  if (cost(lines) <= budget) return { lines };

  // Under `exactOptionalPropertyTypes` a dropped field must be *absent*, not set
  // to undefined — so these destructure the key away rather than overwrite it.
  let shortened = 0;
  let out: SkeletonLine[] = lines.map((l) => {
    if (l.k !== 'assist' || l.text === undefined) return l;
    shortened++;
    const { text: _text, ...rest } = l;
    return rest;
  });
  // `lines` counts every line that lost content, shortened or removed. Reporting
  // 0 here while prose had in fact been stripped would print "0 line(s) elided"
  // into the evidence `explain` shows a user.
  if (cost(out) <= budget) {
    return { lines: out, elided: { lines: shortened, reason: 'token-budget' } };
  }

  const withoutAssist = out.filter((l) => l.k !== 'assist');
  const removed = out.length - withoutAssist.length;
  out = withoutAssist;
  if (cost(out) <= budget) {
    return { lines: out, elided: { lines: shortened + removed, reason: 'token-budget' } };
  }

  out = out.map((l) => {
    if (l.k !== 'tool' || l.target === undefined) return l;
    const { target: _target, ...rest } = l;
    return rest;
  });
  return { lines: out, elided: { lines: shortened + removed, reason: 'token-budget' } };
}

/**
 * Split events into threads: the main thread, plus one per subagent.
 *
 * The key is `undefined` for the main thread and the `sidechainId` for a
 * subagent. One definition, because both the windower and the detector runner
 * need it and two copies would drift.
 *
 * Why this grouping is load-bearing: a flat session array interleaves subagent
 * events among main-thread ones. Anything that cares about *consecutive* events
 * — `tool_loop` above all — is wrong on the flat array, because another actor's
 * call spliced between two identical ones makes them non-consecutive.
 */
export function threadsOf(events: Event[]): Map<string | undefined, Event[]> {
  const threads = new Map<string | undefined, Event[]>();
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const key = e.isSidechain ? (e.sidechainId ?? 'sidechain') : undefined;
    const bucket = threads.get(key);
    if (bucket === undefined) threads.set(key, [e]);
    else bucket.push(e);
  }
  return threads;
}

/**
 * A window: the evidence a detector reads, plus the skeleton a human reads.
 *
 * `events` is the **full** event span the skeleton's lines cover, including the
 * records the skeleton dropped or folded away. That difference is load-bearing:
 * a successful `tool_result` produces no line, so a detector asking "was this
 * edit ever verified" would conclude *no* from the skeleton while the transcript
 * plainly shows a passing test. The skeleton is for reading; the events are for
 * deciding.
 */
export type Window = { skeleton: Skeleton; events: Event[] };

/**
 * Split events into windows and reduce each to a `Skeleton`.
 *
 * Sidechains get their own windows rather than being merged into the main
 * thread or dropped. A parallel fan-out legitimately reads the same files, so
 * merging would make every healthy fan-out look like a reading spiral; dropping
 * would leave 712 events across 99 public transcripts with no coverage at all.
 */
export function buildSkeletons(
  sessionId: string,
  events: Event[],
  opts: SkeletonOptions = {},
): Skeleton[] {
  return buildWindows(sessionId, events, opts).map((w) => w.skeleton);
}

export function buildWindows(
  sessionId: string,
  events: Event[],
  opts: SkeletonOptions = {},
): Window[] {
  const width = opts.width ?? DEFAULTS.width;
  const stride = opts.stride ?? width;
  const budget = opts.tokenBudget ?? DEFAULTS.tokenBudget;
  if (width < 1 || stride < 1) throw new RangeError('width and stride must be >= 1');

  const threads = threadsOf(events);

  const out: Window[] = [];
  for (const [sidechainId, threadEvents] of threads) {
    const { lines, dropsAt } = toLines(threadEvents);
    if (lines.length === 0) continue;

    for (let i = 0; i < lines.length; i += stride) {
      const slice = lines.slice(i, i + width);
      if (slice.length === 0) break;
      const end = i + slice.length;
      const fitted = fitToBudget(slice, budget);
      const first = slice[0]!;
      const last = slice[slice.length - 1]!;

      // Only this window's drops. The trailing bucket belongs to the window that
      // ends the thread, since that is where those events actually sat.
      const dropped: Record<string, number> = {};
      const upTo = end === lines.length ? dropsAt.length : end;
      for (let d = i; d < upTo; d++) {
        for (const [k, n] of Object.entries(dropsAt[d] ?? {})) {
          dropped[k] = (dropped[k] ?? 0) + n;
        }
      }

      // The event span this window covers, sliced from **its own thread**. A
      // sidechain window slicing the global array would pick up every
      // main-thread event that happens to sit between its seq numbers.
      //
      // The first and last window extend to the thread's edges so that records
      // before the first line and after the last — dropped types, mostly — land
      // in exactly one window rather than nowhere.
      const lo = i === 0 ? -Infinity : (first.ref.seq ?? 0);
      const hi = end >= lines.length ? Infinity : (last.ref.seq ?? 0);
      const windowEvents = threadEvents.filter((e) => e.seq >= lo && e.seq <= hi);

      out.push({
        skeleton: {
          ...stamp('skeleton'),
          sessionId,
          window: { from: first.ref, to: last.ref },
          lines: fitted.lines,
          ...(fitted.elided !== undefined ? { elided: fitted.elided } : {}),
          ...(sidechainId !== undefined ? { sidechainId } : {}),
          ...(Object.keys(dropped).length > 0 ? { dropped } : {}),
        },
        events: windowEvents,
      });

      // A final partial window is emitted, but a stride shorter than the width
      // must not re-emit a tail already fully covered by the previous window.
      if (i + width >= lines.length) break;
    }
  }

  return out;
}
