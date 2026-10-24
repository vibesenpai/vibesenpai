/**
 * The hooks, the standing, and the install — Principle Zero as tests.
 *
 * Not formatting tests. Every assertion corresponds to a guarantee that was
 * *claimed* and could be silently false. Two already were: `enqueue` dropped
 * `shownAt` so the statusline's rate limit never engaged, and `isProcessing`
 * rejected a marker whose mtime was a hair ahead of the clock. Neither threw.
 *
 * The statusline and its queue are gone — see GRAVEYARD.md — so the tests that
 * pinned their rate limiting, decay and session scoping went with them.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closed, isTripped, readBreaker, recordFailure, recordSuccess, TRIP_AFTER } from '../src/breaker.ts';
import {
  JUDGE_SECONDS_PER_CALL,
  humanDuration,
  oldestUnread,
  pendingWork,
  progressLine,
  readJudgeState,
} from '../src/judge-store.ts';
import {
  addHook, commandDir, commandFilePath, describeChange, dropOurStatusLine, fixCommandFilePath,
  generateReportCommandBody, generateReportCommandFilePath, legacyCommandFiles, ourCommandFiles,
  planFor, remove, type Settings,
} from '../src/install.ts';
import {
  clearStarted, computeStanding, computedAtLocal, isFresh, isProcessing, markStarted,
  MARKER_STALE_MS, readStanding, standingLine, writeStanding,
  type SessionInput, type Standing,
} from '../src/standing.ts';
import { editRetry } from '../src/detect/edit-retry.ts';
import type { Event } from '../src/types.ts';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'as-ambient-'));


describe('circuit breaker — degrade to silence, not to noise', () => {
  it('trips after repeated failures and records why', () => {
    const dir = scratch();
    for (let i = 0; i < TRIP_AFTER; i++) recordFailure(dir, 'parse exploded');
    const b = readBreaker(dir);
    expect(isTripped(b)).toBe(true);
    expect(b.reason).toBe('parse exploded');
    expect(b.trippedAt).toBeDefined();
  });

  it('closes completely on one success, so a transient failure does not linger', () => {
    const dir = scratch();
    recordFailure(dir, 'once');
    recordSuccess(dir);
    expect(readBreaker(dir)).toEqual(closed());
  });

  it('treats an unreadable breaker as closed, never as permanently disabled', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'breaker.json'), '}}}not json');
    expect(isTripped(readBreaker(dir))).toBe(false);
  });
});

describe('install — merge, never replace', () => {
  /**
   * The real shape measured on this machine: ten hook events, one hook each,
   * and **no `statusLine` key at all**.
   *
   * That last detail matters. An earlier fixture wrote `statusLine: null`,
   * matching a misread of `dict.get()` output, and the round-trip test passed
   * while the real uninstall added a key that had never existed. The fixture
   * now carries the shape the file actually has.
   */
  const realistic = (): Settings => ({
    theme: 'dark',
    model: 'opus',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'mem0-stop.sh' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'mem0-start.sh' }] }],
      PreToolUse: [{ hooks: [{ type: 'command', command: 'mem0-pre.sh' }] }],
    },
  });

  const plan = planFor('/repo/agentsensei', '/usr/bin/node');

  it("leaves somebody else's Stop hook completely alone", () => {
    const after = addHook(realistic(), plan);
    const commands = (after.hooks?.['Stop'] ?? []).flatMap((m) => m.hooks.map((h) => h.command));
    expect(commands).toContain('mem0-stop.sh');
    expect(commands.some((c) => c.includes('hook-stop.ts'))).toBe(true);
    expect(commands).toHaveLength(2);
  });

  it('touches only Stop and SessionStart, and keeps what is in both', () => {
    const before = realistic();
    const after = addHook(before, plan);

    // Every other event is left byte-identical.
    expect(after.hooks?.['PreToolUse']).toEqual(before.hooks?.['PreToolUse']);

    // The two we do use keep their existing entries and gain exactly one.
    for (const event of ['Stop', 'SessionStart'] as const) {
      const theirs = (before.hooks?.[event] ?? []).flatMap((m) => m.hooks.map((h) => h.command));
      const now = (after.hooks?.[event] ?? []).flatMap((m) => m.hooks);
      for (const t of theirs) expect(now.map((h) => h.command), event).toContain(t);
      expect(now.filter((h) => h.__agentsensei === true), event).toHaveLength(1);
    }
  });

  it('never touches unrelated top-level keys', () => {
    const after = addHook(realistic(), plan);
    expect(after.theme).toBe('dark');
    expect(after.model).toBe('opus');
  });

  it('is idempotent — installing twice adds one hook, not two', () => {
    const twice = addHook(addHook(realistic(), plan), plan);
    const ours = (twice.hooks?.['Stop'] ?? [])
      .flatMap((m) => m.hooks)
      .filter((h) => h.__agentsensei === true);
    expect(ours).toHaveLength(1);
  });

  it('gives the hook an explicit timeout, because a hung analyzer must be killed', () => {
    const ours = (addHook(realistic(), plan).hooks?.['Stop'] ?? [])
      .flatMap((m) => m.hooks)
      .find((h) => h.__agentsensei === true);
    expect(ours?.timeout).toBeGreaterThan(0);
    expect(ours?.timeout).toBeLessThanOrEqual(10);
  });

  it('makes the hook exit 0 whatever happens inside it', () => {
    expect(plan.hookCommand.endsWith('|| true')).toBe(true);
  });

  it('never claims the statusline slot', () => {
    // It cost a permanent row of screen for one rarely-changing line, and no
    // official plugin ships one. The report goes in the main window instead.
    const after = addHook(realistic(), plan);
    expect('statusLine' in after).toBe(false);
  });

  it('removes our stale statusline when installing over the old version', () => {
    // The upgrade case, found on a real machine: the previous build set a
    // statusline pointing at `scripts/statusline.ts`, which no longer exists.
    // Installing without clearing it leaves the harness running a command on
    // every render that can only fail.
    const old: Settings = {
      ...realistic(),
      statusLine: { type: 'command', command: '/x/agentsensei/scripts/statusline.ts' },
    };
    const after = addHook(dropOurStatusLine(old), plan);
    expect('statusLine' in after).toBe(false);
  });

  it('still removes a statusline left by the previous version', () => {
    // Nothing sets one any more, but anyone who installed the old build has
    // ours in that slot pointing at a script that no longer exists.
    const stale: Settings = {
      ...realistic(),
      statusLine: { type: 'command', command: '/x/agentsensei/scripts/statusline.ts' },
    };
    expect('statusLine' in remove(stale)).toBe(false);
  });

  it("leaves somebody else's statusline completely alone", () => {
    const theirs: Settings = {
      ...realistic(),
      statusLine: { type: 'command', command: 'my-own-prompt.sh' },
    };
    expect(remove(addHook(theirs, plan)).statusLine).toEqual(theirs.statusLine);
  });

  it('uninstalls to exactly the original settings', () => {
    // The property that makes installing safe to try: it is reversible.
    const before = realistic();
    expect(remove(addHook(before, plan))).toEqual(before);
  });

  it('invents no statusLine key when there was none', () => {
    // Verified against the real file: the key is absent, not null. An earlier
    // uninstall set null here, which made the round-trip inexact, and the
    // fixture encoded the same misread on both sides so the test agreed.
    const before = realistic();
    expect('statusLine' in before).toBe(false);
    expect('statusLine' in remove(addHook(before, plan))).toBe(false);
  });


  it('uninstall removes nothing of anybody else’s, even from an empty group', () => {
    const before: Settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'theirs.sh' }] }] } };
    expect(remove(addHook(before, plan))).toEqual(before);
  });

  it('describes what it touches AND what it leaves alone', () => {
    const before = realistic();
    const lines = describeChange(before, addHook(before, plan)).join('\n');
    expect(lines).toContain('hooks.Stop');
    expect(lines).toMatch(/untouched/);
    expect(lines).toContain('SessionStart'); // named as untouched
  });
});

describe('standing — history is processed so day one is not blank', () => {
  const session = (id: string, events: Event[]): SessionInput => ({
    sessionId: id,
    project: 'p',
    events,
  });

  let n = 0;
  const ev2 = (over: Partial<Event> & Pick<Event, 'turnType'>): Event => {
    n += 1;
    return {
      sessionId: 's',
      harness: 'claude-code',
      uuid: over.uuid ?? `s${n}`,
      parentUuid: null,
      seq: over.seq ?? n,
      isSidechain: false,
      ...over,
    } as Event;
  };

  /** A failed-then-retried edit, using the harness's real message. */
  const retryPair = (path: string): Event[] => {
    const call = ev2({ turnType: 'tool_use', toolName: 'Edit', filePath: path, toolCallId: `c${n}`, argHash: 'h1' });
    return [
      call,
      ev2({
        turnType: 'tool_result', toolCallId: call.toolCallId as string, isError: true, failureKind: 'tool',
        textSummary: '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>',
      }),
      ev2({ turnType: 'tool_use', toolName: 'Edit', filePath: path, toolCallId: `c${n}b`, argHash: 'h2' }),
    ];
  };

  it('aggregates occurrences and session spread across history', async () => {
    const { standing: s } = await computeStanding(
      [session('a', retryPair('/x.ts')), session('b', retryPair('/y.ts')), session('c', [])],
      [editRetry()],
      { now: '2026-10-19T12:00:00.000Z' },
    );
    expect(s.sessions).toBe(3);
    expect(s.dimensions).toEqual([
      {
        dimension: 'edit_retry',
        occurrences: 2,
        sessions: 2,
        files: 2,
        top: { subject: '/x.ts', occurrences: 1 },
      },
    ]);
    expect(s.reasons).toEqual({ 'not-read-first': 2 });
  });

  it('reports sessions it could not read rather than dropping them', async () => {
    const { standing: s } = await computeStanding([session('a', retryPair('/x.ts'))], [editRetry()], { unreadable: 4 });
    expect(s.unreadable).toBe(4);
  });

  it('gives the statusline a past-tense baseline, not a nudge about now', async () => {
    const { standing: s } = await computeStanding([session('a', retryPair('/x.ts'))], [editRetry()]);
    const line = standingLine(s);
    expect(line).toContain('1 edit refused then retried');
    expect(line).toContain('past session');
    // It sits there indefinitely, so it must never read as an accusation.
    for (const nag of ['fix', 'should', 'must', 'warning', 'now', '!']) {
      expect(line.toLowerCase(), `must not contain "${nag}"`).not.toContain(nag);
    }
  });

  it('says nothing when history is clean', async () => {
    // "No findings across 174 edits" is a real result but not worth a permanent
    // line in someone's status bar.
    const { standing: s } = await computeStanding([session('a', [])], [editRetry()]);
    expect(standingLine(s)).toBe('');
  });

  it('survives a missing or corrupt file', () => {
    const dir = scratch();
    expect(readStanding(dir)).toBeUndefined();
    writeFileSync(join(dir, 'standing.json'), 'not json');
    expect(readStanding(dir)).toBeUndefined();
    writeFileSync(join(dir, 'standing.json'), JSON.stringify({ v: 99, dimensions: [] }));
    expect(readStanding(dir)).toBeUndefined();
  });

  it('round-trips through the archive', async () => {
    const dir = scratch();
    const { standing: s } = await computeStanding([session('a', retryPair('/x.ts'))], [editRetry()]);
    expect(writeStanding(dir, s)).toBe(true);
    expect(readStanding(dir)).toEqual(s);
  });

  it('will not recompute while fresh, so four windows do not parse four times', () => {
    const now = Date.parse('2026-10-19T12:00:00.000Z');
    const fresh = { ...({} as Standing), v: 1, computedAt: '2026-10-19T11:59:00.000Z', dimensions: [] };
    const stale = { ...fresh, computedAt: '2026-10-19T10:00:00.000Z' };
    expect(isFresh(fresh as Standing, now)).toBe(true);
    expect(isFresh(stale as Standing, now)).toBe(false);
    expect(isFresh(undefined, now)).toBe(false);
  });

  it('shows the computed time in local, not UTC', async () => {
    // Printing the stored UTC raw showed 01:46 to someone whose clock said
    // 18:46 — a number that reads as wrong rather than as another zone.
    const { standing: s } = await computeStanding([session('a', [])], [editRetry()], { now: '2026-10-19T12:00:00.000Z' });
    const local = computedAtLocal(s);
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(local).not.toContain('T');
  });
});

describe('standing — "sit tight" while the first pass runs', () => {
  it('reports processing between the mark and the clear', () => {
    const dir = scratch();
    expect(isProcessing(dir)).toBe(false);
    markStarted(dir);
    expect(isProcessing(dir)).toBe(true);
    clearStarted(dir);
    expect(isProcessing(dir)).toBe(false);
  });

  it('stops believing a marker a dead pass left behind', () => {
    // A status bar saying "reading your past sessions" forever would be worse
    // than saying nothing, so the failure mode is going quiet.
    const dir = scratch();
    markStarted(dir);
    expect(isProcessing(dir, Date.now() + MARKER_STALE_MS + 1000)).toBe(false);
  });

  it('tolerates a marker whose mtime is a hair ahead of the clock', () => {
    // Not hypothetical: a file written and checked in the same millisecond can
    // report an mtime fractionally ahead of Date.now(), and a `>= 0` guard made
    // the friendly line never appear. A badly wrong clock still ages out.
    const dir = scratch();
    markStarted(dir);
    expect(isProcessing(dir, Date.now() - 5)).toBe(true);
    expect(isProcessing(dir, Date.now() - MARKER_STALE_MS - 1000)).toBe(false);
  });

  it('clearing a marker that is not there is harmless', () => {
    expect(() => clearStarted(scratch())).not.toThrow();
  });

  // `processingLine()` used to live here: `⌁ reading your past sessions…`,
  // written for the statusline. The statusline was removed (D58) and the
  // function kept its test while losing every production caller — a passing
  // test for code nothing runs.
  //
  // The job it was meant to do is real, and it moved: the only slow thing in
  // this tool is the judge, so the "still working" signal is now computed from
  // the judge ledger and shown by `now` and `standing`. These assert the
  // calculation behind it, since that is what ships.
  it('reports nothing pending when every session is up to date', () => {
    const state = { ...readJudgeState(scratch()), ledger: { a: 500, b: 200 } };
    const w = pendingWork(state, [
      { id: 'a', sizeBytes: 500 },
      { id: 'b', sizeBytes: 200 },
    ]);
    // `unread` and `behind` split what `pending` used to conflate: a session
    // never looked at, and one read before it grew. Only the first is what a
    // person means by "not analysed yet", and a live session is permanently
    // the second — so a count including it could never reach zero.
    expect(w).toEqual({ pending: 0, judged: 2, unread: 0, behind: 0, seconds: 0 });
  });

  it('counts a grown session as pending and estimates two calls for it', () => {
    const state = { ...readJudgeState(scratch()), ledger: { a: 500 } };
    const w = pendingWork(state, [
      { id: 'a', sizeBytes: 900 },
      { id: 'new', sizeBytes: 100 },
    ]);
    expect(w.pending).toBe(2);
    expect(w.judged).toBe(0);
    // Two calls each at the measured ~30s, which is a ceiling: a batch holds
    // however many sessions fit the token limit.
    expect(w.seconds).toBe(2 * 2 * JUDGE_SECONDS_PER_CALL);
  });

  it('rounds a duration coarsely, because the estimate is an average', () => {
    expect(humanDuration(45)).toBe('45 seconds');
    expect(humanDuration(60)).toBe('60 seconds');
    expect(humanDuration(300)).toBe('5 minutes');
    expect(humanDuration(60 * 60)).toBe('1.0 hours');
    // No false precision: never "5m 12s".
    expect(humanDuration(312)).not.toMatch(/\d+m/);
  });
});

describe('install — commands are namespaced by their directory', () => {
  it('nests them so they read as /agentsensei:insights and :fix', () => {
    // A command at `.claude/commands/agentsensei/fix.md` is `/agentsensei:fix`;
    // the same file flat is `/agentsensei-fix`. From the harness changelog:
    // "Restored namespacing in command names based on subdirectories".
    expect(commandFilePath('/h')).toBe('/h/.claude/commands/agentsensei/now.md');
    expect(fixCommandFilePath('/h')).toBe('/h/.claude/commands/agentsensei/fix.md');
  });

  it('knows the flat files an earlier version wrote', () => {
    // Left behind they would show up as a second, un-namespaced /agentsensei.
    expect(legacyCommandFiles('/h')).toEqual([
      '/h/.claude/commands/agentsensei.md',
      '/h/.claude/commands/agentsensei-fix.md',
    ]);
  });
});

describe('install — SessionStart triggers the standing pass', () => {
  const plan = planFor('/repo/agentsensei', '/usr/bin/node');
  const withTheirs = (): Settings => ({
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'theirs-stop.sh' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'theirs-start.sh' }] }],
    },
  });

  it('adds to SessionStart without touching what is there', () => {
    const after = addHook(withTheirs(), plan);
    const cmds = (after.hooks?.['SessionStart'] ?? []).flatMap((m) => m.hooks.map((h) => h.command));
    expect(cmds).toContain('theirs-start.sh');
    expect(cmds.some((c) => c.includes('hook-session-start.ts'))).toBe(true);
  });

  it('still uninstalls to exactly the original', () => {
    const before = withTheirs();
    expect(remove(addHook(before, plan))).toEqual(before);
  });

  it('the SessionStart command exits 0 whatever happens', () => {
    expect(plan.sessionStartCommand.endsWith('|| true')).toBe(true);
  });
});

describe('command files — install and uninstall cannot disagree', () => {
  it('lists all three, so rmdirSync is never left a non-empty directory', () => {
    // The failure is silent: uninstall removes what it knows about, then calls
    // `rmdirSync`, which refuses a non-empty directory and throws into an empty
    // catch. A file we created and forgot to list would quietly cost the
    // byte-identical uninstall the CLI verifies with a diff.
    expect(ourCommandFiles('/home/x')).toEqual([
      commandFilePath('/home/x'),
      fixCommandFilePath('/home/x'),
      generateReportCommandFilePath('/home/x'),
    ]);
  });

  it('namespaces all three under the one subdirectory', () => {
    // `.claude/commands/agentsensei/fix.md` is `/agentsensei:fix`; the same
    // file flat would be `/agentsensei-fix`.
    for (const f of ourCommandFiles('/home/x')) {
      expect(f.startsWith(`${commandDir('/home/x')}/`)).toBe(true);
      expect(f.endsWith('.md')).toBe(true);
    }
  });

  it('tells the model not to restate the report it just wrote', () => {
    // The other two bodies ask for verbatim reproduction because the output IS
    // the evidence. Here the evidence is a file, so restating it would hand a
    // paraphrase to someone already looking at the real thing.
    const body = generateReportCommandBody('/repo');
    expect(body).toMatch(/do not summarise/i);
    expect(body).toContain('--html');
  });

  it('opens the report, because that is what the command is for', () => {
    // Opt-in at the CLI, passed here: someone typing the command is asking to
    // look at a report, so handing them a path to copy is a step with no
    // purpose. `report --html` alone still opens nothing — it can be piped.
    expect(generateReportCommandBody('/repo')).toContain('--html --open');
  });
});

describe('the backlog drains, which it did not', () => {
  // The only automatic spawner is the `Stop` hook and it judged just the live
  // session; the backlog was reachable solely through `judge --backlog
  // --apply`, a CLI command that under D64 nobody types. Measured on a real
  // machine before this change: `pending 25 session(s)`, `judged 0`.
  const state = (ledger: Record<string, number>) =>
    ({ ...readJudgeState(scratch()), ledger }) as Parameters<typeof oldestUnread>[0];
  const sizes = [
    { id: 'old', sizeBytes: 100, mtimeMs: 1 },
    { id: 'mid', sizeBytes: 100, mtimeMs: 2 },
    { id: 'new', sizeBytes: 100, mtimeMs: 3 },
  ];

  it('picks the session nobody has ever looked at, oldest first', () => {
    expect(oldestUnread(state({}), sizes)).toBe('old');
  });

  it('skips one that was read and merely grew', () => {
    // Picking the oldest *pending* session would keep returning to ones
    // already mostly covered — a live session is always pending — while
    // sessions nobody has looked at wait behind them.
    expect(oldestUnread(state({ old: 50 }), sizes)).toBe('mid');
  });

  it('walks forward rather than stalling on one session', () => {
    const ledger: Record<string, number> = {};
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = oldestUnread(state(ledger), sizes);
      if (id === undefined) break;
      order.push(id);
      ledger[id] = 100;
    }
    expect(order).toEqual(['old', 'mid', 'new']);
  });

  it('has nothing to offer once everything has been read', () => {
    expect(oldestUnread(state({ old: 100, mid: 100, new: 100 }), sizes)).toBeUndefined();
  });

  it('is a reason to start a pass, not a narrowing of what it reads', () => {
    // The hook used to branch — judge the live session, else drain one backlog
    // session. Measured on a real machine, it never went the second way: the
    // live session grows 296,961 bytes per prompt against a 20,000-byte
    // threshold, so it is due after 0.07 of one and `oldestUnread` was dead
    // code. The user saw it as "the whole day had passed and only 2 sessions
    // were read".
    //
    // There was never a choice to make. A pass with no session id takes every
    // session past its watermark, the live one included, and packs them to the
    // budget — 5 batched passes for this machine's 29 sessions rather than 29
    // single ones.
    const hook = readFileSync('scripts/hook-stop.ts', 'utf8');
    expect(hook, 'the backlog is still a reason to spawn').toMatch(/oldestUnread/);
    expect(hook, 'and so is the live session').toMatch(/dueForJudging/);
    expect(hook, 'but the pass is never narrowed to one session').toMatch(
      /spawnDetached\('judge\.ts'\)/,
    );
    expect(hook).not.toMatch(/spawnDetached\('judge\.ts',/);
  });
});

describe('the ETA is in the unit that governs it', () => {
  // Two ETAs existed and both reported compute time to a reader who will hear
  // wall-clock time. The session one was literally the constant string "60
  // seconds" — `humanDuration(2 * JUDGE_SECONDS_PER_CALL)` — independent of
  // elapsed time, batch size, or whether the running pass covered that
  // session at all. The status one said "about 25 minutes at ~30s per call".
  //
  // What paces completion is turn boundaries: the Stop hook reads one session
  // per idle one, so the same 25 minutes of model time is an afternoon or
  // three days depending on how much someone works.
  it('counts queued work in sessions and turns, never minutes', () => {
    const line = progressLine({ unread: 24 });
    expect(line).toMatch(/24 sessions/);
    expect(line).toMatch(/per turn/);
    expect(line, 'a queue paced by turns must not quote minutes').not.toMatch(/minute|second/);
  });

  it('gives a real duration only for a pass actually in flight', () => {
    // The one case where elapsed-against-expected is a fact rather than an
    // extrapolation.
    const line = progressLine({ unread: 24, running: { elapsedMs: 20_000 } });
    expect(line).toMatch(/Reading a session now/);
    expect(line).toMatch(/40 seconds left/);
  });

  it('prefers what calls really took here over the constant', () => {
    const line = progressLine({ unread: 0, running: { elapsedMs: 2_000 }, callMs: 5_000 });
    expect(line, '2 x 5s measured, 2s elapsed → 8s left').toMatch(/8 seconds left/);
  });

  it('says so rather than counting past the estimate', () => {
    expect(progressLine({ unread: 0, running: { elapsedMs: 10 * 60_000 } })).toMatch(/nearly done/);
  });

  it('covers the window where a pass is spawned but has not recorded itself', () => {
    // The marker is written by the spawner and the `run` row by the pass, so
    // between them something is running and nothing can say for how long.
    expect(progressLine({ unread: 3, spawned: true })).toBe('Reading a session now.');
  });

  it('says nothing at all when there is nothing outstanding', () => {
    expect(progressLine({ unread: 0 })).toBe('');
  });
});
