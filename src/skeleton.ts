/**
 * The skeletonizer: `Event[]` → windows → `Skeleton[]` (docs/contracts.md §3).
 * A window is 6–12 skeleton lines. Windows do not overlap by default; `occurrences` counts
 * distinct anchors, so a smaller `stride` is safe.
 */

import { stamp } from './schema.ts';
import type { Event, Skeleton, SkeletonLine, TurnRef } from './types.ts';

export type SkeletonOptions = {
  /** Lines per window. The spec's 6–12; 12 is the upper bound, not a target. */
  width?: number;
  /** Lines advanced between windows. Defaults to `width` — no overlap. */
  stride?: number;
  /** Token ceiling per window; 2K fits a 4K prompt with rubric. */
  tokenBudget?: number;
};

const DEFAULTS = { width: 12, stride: undefined, tokenBudget: 2000 } as const;

/** Rough token estimate: 4 characters per token. A ceiling, so no real tokenizer is needed. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Git commit/revert, promoted to a meta line. Display only; it produces no finding. */
function gitMeta(command: string | undefined): 'commit' | 'revert' | undefined {
  if (command === undefined) return undefined;
  // Ignore heredoc bodies: a doc mentioning `git commit` is not a commit.
  const exec = executablePart(command);
  if (/\bgit\s+(?:-\S+\s+)*commit\b/.test(exec)) return 'commit';
  if (/\bgit\s+(?:revert|reset\s+--hard)\b|\bgit\s+checkout\s+--/.test(exec)) return 'revert';
  return undefined;
}

function refOf(e: Event): TurnRef {
  return { uuid: e.uuid, sessionId: e.sessionId, seq: e.seq };
}

/**
 * Enough of a (pre-redacted) command to tell invocations apart: first line, leading shell
 * punctuation stripped, capped by characters on a word boundary.
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

type LineResult = {
  lines: SkeletonLine[];
  /** Thread total — every type with no line representation, counted. */
  dropped: Record<string, number>;
  /**
   * `dropsAt[i]` is what was dropped just before line `i` (trailing bucket at `lines.length`),
   * so each window reports only its own drops.
   */
  dropsAt: Record<string, number>[];
};

/** Events → lines. Successful results are omitted; a failed result always gets a line. */
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
        // No text: nothing to show, and its tool calls have their own lines.
        if (e.textSummary === undefined) {
          drop('assistant_msg:no-text');
          break;
        }
        emit({ k: 'assist', ref, text: e.textSummary, ...flag });
        break;

      case 'tool_use': {
        // A commit or revert is an outcome signal, so it becomes a meta line.
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
          // Omitted, not merged: `Event` has no edit size, so `lines` stays unset.
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
        // Not a human prompt; see TurnType in types.ts.
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

/** The text rendering, for models and humans. Elision is printed, never silent. */
export function renderSkeleton(sk: Skeleton): string {
  const body = sk.lines.map(renderLine).join('\n');
  if (sk.elided === undefined) return body;
  return `${body}\n…  ${sk.elided.lines} line(s) shortened or dropped (${sk.elided.reason})`;
}

/**
 * Bring a window under its token ceiling: drop assistant prose, then assistant lines, then tool
 * targets. User, failure and meta lines are never dropped; if still over, emit over budget.
 */
function fitToBudget(
  lines: SkeletonLine[],
  budget: number,
): { lines: SkeletonLine[]; elided?: { lines: number; reason: 'token-budget' } } {
  const cost = (ls: SkeletonLine[]): number => estimateTokens(ls.map(renderLine).join('\n'));
  if (cost(lines) <= budget) return { lines };

  // `exactOptionalPropertyTypes`: destructure the key away rather than set undefined.
  let shortened = 0;
  let out: SkeletonLine[] = lines.map((l) => {
    if (l.k !== 'assist' || l.text === undefined) return l;
    shortened++;
    const { text: _text, ...rest } = l;
    return rest;
  });
  // `elided.lines` counts every line that lost content, shortened or removed.
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
 * Split events into threads, keyed `undefined` for main and `sidechainId` per subagent.
 * Consecutive-event logic must run per thread: the flat array interleaves actors.
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
 * A skeleton for reading plus the full event span for deciding. `events` includes records the
 * skeleton omitted (e.g. successful results), which detectors need.
 */
export type Window = { skeleton: Skeleton; events: Event[] };

/** Split events into windows and reduce each to a `Skeleton`. Sidechains get their own windows. */
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

      // Only this window's drops; the last window takes the trailing bucket.
      const dropped: Record<string, number> = {};
      const upTo = end === lines.length ? dropsAt.length : end;
      for (let d = i; d < upTo; d++) {
        for (const [k, n] of Object.entries(dropsAt[d] ?? {})) {
          dropped[k] = (dropped[k] ?? 0) + n;
        }
      }

      // Sliced from this thread only. The first and last windows extend to the
      // thread's edges so every event lands in exactly one window.
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

      // Don't re-emit a tail already covered when stride < width.
      if (i + width >= lines.length) break;
    }
  }

  return out;
}

// Command text, for display only. No detector may read it: CLAUDE.md "A detector reads structure".

/** Remove heredoc bodies (data, not commands): `cat > f <<'EOF' … EOF` becomes `cat > f`. */
function stripHeredocs(command: string): string {
  const lines = command.split('\n');
  const out: string[] = [];
  let terminator: string | undefined;

  for (const line of lines) {
    if (terminator !== undefined) {
      // Inside a body: the terminator may be indented when `<<-` was used.
      if (line.trim() === terminator) terminator = undefined;
      continue;
    }
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (m !== null) {
      terminator = m[2] as string;
      out.push(line.slice(0, m.index));
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** The executable part of a command: heredoc bodies and trailing `#` comments removed. */
function executablePart(command: string | undefined): string {
  if (command === undefined) return '';
  return stripHeredocs(command)
    .split('\n')
    .map((l) => l.replace(/\s+#\s.*$/, ''))
    .join('\n');
}
