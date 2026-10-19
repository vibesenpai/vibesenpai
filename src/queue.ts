/**
 * The ambient queue — what the statusline is allowed to say, and when.
 *
 * ── Why a queue at all ──────────────────────────────────────────────────────
 *
 * A `Stop` hook has a timeout budget, and running detectors inside it would add
 * latency to every single response. Measured: parsing is 95% of the cost and a
 * 20 MB session takes ~420ms, which is far too much to spend at a response
 * boundary. So the hook never analyses. It drains, advances, and may spawn a
 * detached analyser whose results land here for the *next* boundary.
 *
 * That makes batching honest rather than a limitation: a finding is about a span
 * of turns, and the span has to close before the finding exists.
 *
 * ── Why the statusline never writes ────────────────────────────────────────
 *
 * Claude Code invokes a statusline script often and on its own schedule. A
 * writer there would race itself and could corrupt the file under exactly the
 * conditions nobody is watching. So writes happen only at a `Stop` boundary,
 * which is a single serialised moment, and the statusline is strictly a reader.
 *
 * ── Principle One, enforced in the data rather than in the renderer ────────
 *
 * The worst acceptable outcome is that a nudge goes unnoticed. Three of the
 * rules live here because a renderer that had to remember them would eventually
 * forget:
 *
 *   - **Rate limited.** At most one change per `MIN_BOUNDARIES_BETWEEN`
 *     boundaries, however deep the queue is.
 *   - **It decays.** An unacted entry is dropped after `DECAY_BOUNDARIES`
 *     rather than sitting there accusing someone indefinitely.
 *   - **Never on the first boundary of a session.** Arriving to a nudge before
 *     doing anything reads as a verdict on work that has not happened yet.
 *
 * ── Principle Zero ─────────────────────────────────────────────────────────
 *
 * Every read returns a usable value. A missing, truncated, or garbage file is
 * indistinguishable from an empty queue on purpose: the statusline's job is to
 * be silent when it has nothing to say, and a throw here would put a stack
 * trace in someone's status bar. Writes are temp-then-rename, so a crash
 * mid-write cannot leave a half-written queue behind.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding } from './types.ts';

const QUEUE_FILE = 'queue.json';
const QUEUE_VERSION = 1;

/** At most one change per this many response boundaries. */
export const MIN_BOUNDARIES_BETWEEN = 3;

/** An entry nobody acted on disappears after this many boundaries. */
export const DECAY_BOUNDARIES = 12;

export type QueueEntry = {
  sessionId: string;
  dimension: string;
  subject: string;
  occurrences: number;
  confidence: string;
  /** The boundary count when this entry was added, for decay. */
  addedAt: number;
  /** The boundary count when it was last shown, for rate limiting. */
  shownAt?: number;
};

export type Queue = {
  v: number;
  /** Response boundaries seen in this session. The clock everything here uses. */
  boundaries: number;
  entries: QueueEntry[];
};

export function emptyQueue(): Queue {
  return { v: QUEUE_VERSION, boundaries: 0, entries: [] };
}

function pathFor(archive: string): string {
  return join(archive, QUEUE_FILE);
}

/**
 * Read the queue, or an empty one.
 *
 * Never throws. A version we do not recognise is treated as absent rather than
 * migrated in place: an older binary reading a newer queue should go quiet, not
 * guess at a shape it does not know.
 */
export function readQueue(archive: string): Queue {
  try {
    const raw = JSON.parse(readFileSync(pathFor(archive), 'utf8')) as Partial<Queue>;
    if (raw.v !== QUEUE_VERSION || !Array.isArray(raw.entries)) return emptyQueue();
    return {
      v: QUEUE_VERSION,
      boundaries: typeof raw.boundaries === 'number' ? raw.boundaries : 0,
      entries: raw.entries.filter((e): e is QueueEntry => typeof e?.dimension === 'string'),
    };
  } catch {
    return emptyQueue();
  }
}

/**
 * Write the queue, temp-then-rename.
 *
 * Returns whether it succeeded rather than throwing: a read-only archive or a
 * full disk must cost a nudge, never a session.
 */
export function writeQueue(archive: string, q: Queue): boolean {
  try {
    mkdirSync(archive, { recursive: true, mode: 0o700 });
    const tmp = `${pathFor(archive)}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(q, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, pathFor(archive));
    return true;
  } catch {
    return false;
  }
}

/**
 * Field separator for the dedup key.
 *
 * Written as an **escape**, never as the character. The project has been here
 * before: a literal NUL in `src/verify.ts` meant a later edit targeting that
 * line matched nothing, applied silently, and left a type disagreeing with its
 * implementation while every test passed. `test/source-hygiene.test.ts` makes it
 * a build failure, and it caught this line too.
 *
 * NUL rather than a space because a path or a dimension could contain a space,
 * and a separator that can appear in a field is not a separator.
 */
const SEP = '\u0000';

/** Identity for dedup: the same finding must not queue twice. */
function keyOf(e: Pick<QueueEntry, 'sessionId' | 'dimension' | 'subject'>): string {
  return [e.sessionId, e.dimension, e.subject].join(SEP);
}

/**
 * Add findings, replacing any already queued for the same subject.
 *
 * Replacing rather than appending keeps `occurrences` current: a loop that grew
 * from 3 to 5 is the same finding, and queueing it twice would show it twice.
 *
 * **`addedAt` and `shownAt` survive the replacement**, and that is load-bearing
 * rather than tidy. The detached analyser re-enqueues every boundary, so an
 * `enqueue` that dropped them would reset decay and the rate limit on every
 * single run — the nudge would never expire and never pace itself. Found by
 * running the pipeline and noticing `shownAt` was absent from the file;
 * nothing threw, and both Principle One guarantees were quietly gone.
 */
export function enqueue(q: Queue, sessionId: string, findings: Finding[]): Queue {
  const entries = [...q.entries];
  for (const f of findings) {
    const entry: QueueEntry = {
      sessionId,
      dimension: f.dimension,
      subject: f.subject,
      occurrences: f.occurrences,
      confidence: f.confidence,
      addedAt: q.boundaries,
    };
    const at = entries.findIndex((e) => keyOf(e) === keyOf(entry));
    if (at === -1) {
      entries.push(entry);
      continue;
    }
    const prior = entries[at] as QueueEntry;
    entries[at] = {
      ...entry,
      addedAt: prior.addedAt,
      ...(prior.shownAt !== undefined ? { shownAt: prior.shownAt } : {}),
    };
  }
  return { ...q, entries };
}

/**
 * Advance the boundary clock and drop what has decayed.
 *
 * Called once per `Stop`. Decay is measured from when an entry was added, not
 * from when it was shown: an entry that never got its turn because the queue was
 * busy still expires, because by then it is about work long past.
 */
export function advance(q: Queue): Queue {
  const boundaries = q.boundaries + 1;
  return {
    ...q,
    boundaries,
    entries: q.entries.filter((e) => boundaries - e.addedAt < DECAY_BOUNDARIES),
  };
}

/**
 * What the statusline should say now, or nothing.
 *
 * Read-only, and the rate limit and first-boundary rule are applied here so
 * both the hook and the statusline get the same answer from the same state.
 */
export function pick(q: Queue): QueueEntry | undefined {
  // Never on the first boundary: a nudge before any work has happened reads as
  // a verdict on work that has not happened yet.
  if (q.boundaries < 1) return undefined;

  const lastShown = q.entries.reduce<number>(
    (n, e) => (e.shownAt !== undefined && e.shownAt > n ? e.shownAt : n),
    -Infinity,
  );
  if (q.boundaries - lastShown < MIN_BOUNDARIES_BETWEEN) {
    // Inside the rate limit: keep showing whatever is already current rather
    // than going blank, because a line that flickers is worse than a stale one.
    return q.entries.find((e) => e.shownAt === lastShown);
  }
  // Oldest unshown first — the queue is a queue.
  return q.entries.find((e) => e.shownAt === undefined) ?? q.entries.find((e) => e.shownAt === lastShown);
}

/** Record that an entry was shown, so the rate limit and decay can see it. */
export function markShown(q: Queue, entry: QueueEntry): Queue {
  return {
    ...q,
    entries: q.entries.map((e) =>
      keyOf(e) === keyOf(entry) && e.shownAt === undefined ? { ...e, shownAt: q.boundaries } : e,
    ),
  };
}

/**
 * The line itself.
 *
 * **A statement of fact.** No imperative verb, no severity word, no colour, no
 * punctuation that raises its voice. The statusline cannot interrupt, but it can
 * still nag, and a tool that nags about something it is occasionally wrong about
 * gets uninstalled. Detail belongs in `agentsensei now`, which is named here
 * exactly once so the line stays short.
 */
export function lineFor(entry: QueueEntry | undefined, queued = 0): string {
  if (entry === undefined) return '';
  const what =
    entry.dimension === 'edit_retry'
      ? `${entry.occurrences} edit${entry.occurrences === 1 ? '' : 's'} refused then retried`
      : entry.dimension === 'redundant_call'
        ? `${entry.occurrences} identical calls, same answer`
        : `${entry.dimension} ×${entry.occurrences}`;
  const more = queued > 1 ? ` · +${queued - 1} more` : '';
  return `⌁ ${what}${more}`;
}
