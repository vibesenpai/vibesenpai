// `scripts/judge.ts` as a whole pass: real script, store and lock; only the model is a stub that logs
// each call's start and end, so concurrency is observed rather than assumed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBreaker } from '../src/breaker.ts';
import { readJudgeState } from '../src/judge/state.ts';
import { JUDGE_LOCK_OWNER_ENV, clearJudgeRunning, judgeLockOwner, judgeRunning, takeJudgeLock, touchJudgeLock, JUDGE_RUNNING_STALE_MS } from '../src/judge/lock.ts';
import { openStore } from '../src/store.ts';
import { renderExtract } from '../src/judge/prompt.ts';
import { buildSession, estimateTokens } from '../src/judge/packet.ts';
import { parseTranscript, withFullText } from '../src/parsers/claude-code.ts';

let root: string;
let sources: string;
let archive: string;
let bin: string;
let log: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentsensei-drain-'));
  sources = join(root, 'projects', '-Users-test-proj');
  archive = join(root, 'archive');
  bin = join(root, 'bin');
  log = join(root, 'calls.log');
  for (const d of [sources, archive, bin]) mkdirSync(d, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A small real transcript: one prompt, one reply, padded to a known size. */
function session(id: string, words: number): void {
  const prompt = Array.from({ length: words }, (_, i) => `word${i}`).join(' ');
  const lines = [
    { type: 'user', uuid: `${id}-u`, sessionId: id, timestamp: '2026-10-20T10:00:00.000Z', version: '2.1.296', message: { role: 'user', content: prompt } },
    { type: 'assistant', uuid: `${id}-a`, sessionId: id, timestamp: '2026-10-20T10:00:05.000Z', version: '2.1.296', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  ];
  writeFileSync(join(sources, `${id}.jsonl`), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
}

/** A `claude` that sleeps, logs start and end, and finds nothing — or fails. */
function fakeClaude(opts: { fail?: boolean; ms?: number; grow?: string } = {}): void {
  // `grow`: the stub appends a turn per call, like a live session growing during a pass.
  const grow = opts.grow === undefined
    ? ''
    : `appendFileSync(${JSON.stringify(opts.grow)}, JSON.stringify({ type: 'user', uuid: 'g' + Date.now() + Math.random(), sessionId: 'live', timestamp: '2026-10-20T10:01:00.000Z', version: '2.1.296', message: { role: 'user', content: 'more work ' + 'x '.repeat(400) } }) + '\\n');`;
  const script = `#!${process.execPath}
const { appendFileSync } = require('node:fs');
appendFileSync(${JSON.stringify(log)}, 'start ' + Date.now() + '\\n');
${grow}
// The real CLI reads stdin when it is not a TTY. Wait for EOF as it would, so
// a caller that leaves stdin open hangs here instead of passing.
process.stdin.resume();
process.stdin.on('end', () => setTimeout(() => {
  appendFileSync(${JSON.stringify(log)}, 'end ' + Date.now() + '\\n');
  ${opts.fail === true ? 'process.exit(1);' : `process.stdout.write(JSON.stringify({ result: JSON.stringify({ sessions: [] }), usage: { input_tokens: 100, output_tokens: 10 }, duration_ms: ${opts.ms ?? 400} }));`}
}, ${opts.ms ?? 400}));
`;
  writeFileSync(join(bin, 'claude'), script);
  chmodSync(join(bin, 'claude'), 0o755);
}

function settings(over: Record<string, unknown>): void {
  writeFileSync(
    join(archive, 'judge-settings.json'),
    JSON.stringify({ enabled: true, model: 'haiku', cadence: 50, maxBatchTokens: 60_000, concurrency: 3, ...over }),
  );
}

function runPass(env: Record<string, string> = {}): void {
  spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/judge.ts'], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      AGENTSENSEI_SOURCES: join(root, 'projects'),
      AGENTSENSEI_ARCHIVE: archive,
      NODE_NO_WARNINGS: '1',
      ...env,
    },
    timeout: 60_000,
  });
}

/** Most calls in flight at once, from the stub's own log. */
function peakConcurrency(): { calls: number; peak: number } {
  const events = readFileSync(log, 'utf8').trim().split('\n').map((l) => {
    const [kind, t] = l.split(' ');
    return { kind, t: Number(t) };
  });
  events.sort((a, b) => a.t - b.t || (a.kind === 'end' ? -1 : 1));
  let now = 0;
  let peak = 0;
  for (const e of events) {
    now += e.kind === 'start' ? 1 : -1;
    peak = Math.max(peak, now);
  }
  return { calls: events.filter((e) => e.kind === 'start').length, peak };
}

/** A budget that holds one of these sessions per batch and never two. */
function oneSessionBudget(id = 's0'): number {
  const r = withFullText(() =>
    parseTranscript(readFileSync(join(sources, `${id}.jsonl`), 'utf8').split('\n'), id),
  );
  const one = buildSession(id, [...r.result.events], r.fullText);
  const single = estimateTokens(renderExtract([one]));
  const pair = estimateTokens(renderExtract([one, { ...one, sessionId: `${id}x` }]));
  expect(pair).toBeGreaterThan(single);
  return Math.floor((single + pair) / 2);
}

describe('a pass drains the backlog, three calls at a time', () => {
  it('reads every session in one pass, with calls overlapping', () => {
    for (let i = 0; i < 6; i += 1) session(`s${i}`, 500);
    settings({ maxBatchTokens: oneSessionBudget() });
    fakeClaude();

    runPass();

    const state = readJudgeState(archive);
    for (let i = 0; i < 6; i += 1) {
      const size = statSync(join(sources, `s${i}.jsonl`)).size;
      expect(state.ledger[`s${i}`], `s${i} read to the end`).toBe(size);
    }
    const { calls, peak } = peakConcurrency();
    expect(calls, 'one call per batch, six batches').toBe(6);
    expect(peak, 'never more than the setting').toBeLessThanOrEqual(3);
    expect(peak, 'and actually concurrent').toBeGreaterThan(1);
    expect(state.usage?.calls).toBe(6);
  });

  it('reads the backlog as it stood, not a live session that keeps growing', () => {
    // Plan once per pass: re-planning each round would resend the live session's new bytes forever.
    for (let i = 0; i < 6; i += 1) session(`s${i}`, 500);
    session('live', 500);
    settings({ maxBatchTokens: oneSessionBudget() });
    const live = join(sources, 'live.jsonl');
    const before = statSync(live).size;
    fakeClaude({ grow: live });

    runPass();

    expect(peakConcurrency().calls, 'one call per session in the snapshot').toBe(7);
    expect(statSync(live).size, 'it did grow during the pass').toBeGreaterThan(before);
    expect(readJudgeState(archive).ledger['live'], 'read to where it stood').toBe(before);
  });

  it('records one run row per call, so the measured rate is per call', () => {
    for (let i = 0; i < 3; i += 1) session(`s${i}`, 500);
    settings({ maxBatchTokens: oneSessionBudget() });
    fakeClaude();

    runPass();

    const db = openStore(archive);
    try {
      const rows = db.prepare('SELECT packet_tokens, ended_at FROM run').all();
      expect(rows).toHaveLength(3);
      for (const r of rows) {
        expect(r['ended_at']).not.toBeNull();
        expect(Number(r['packet_tokens'])).toBeGreaterThan(0);
      }
    } finally {
      db.close();
    }
  });

  it('stops at the first failing round, and counts it as one fault', () => {
    for (let i = 0; i < 6; i += 1) session(`s${i}`, 500);
    settings({ maxBatchTokens: oneSessionBudget() });
    fakeClaude({ fail: true });

    runPass();

    expect(peakConcurrency().calls, 'the second round never started').toBe(3);
    expect(readBreaker(archive).consecutiveFailures, 'three calls, one rate limit, one fault').toBe(1);
    expect(Object.keys(readJudgeState(archive).ledger), 'nothing advanced').toHaveLength(0);
  });

  it('releases the lock its spawner took', () => {
    session('s0', 50);
    fakeClaude();
    expect(takeJudgeLock(archive)).toBe(true);

    runPass({ [JUDGE_LOCK_OWNER_ENV]: String(process.pid) });

    expect(existsSync(join(archive, 'judge.running')), 'released, not left to age out').toBe(false);
  });
});

describe('the lock outlives a long drain, and no longer', () => {
  it('releases as the spawner, whose pid is stamped on it', () => {
    expect(takeJudgeLock(archive)).toBe(true);
    // The pass is another process: its own pid would leave the lock in place.
    clearJudgeRunning(archive, process.pid + 1);
    expect(judgeRunning(archive)).toBe(true);
    clearJudgeRunning(archive, judgeLockOwner({ [JUDGE_LOCK_OWNER_ENV]: String(process.pid) }));
    expect(judgeRunning(archive)).toBe(false);
  });

  it('stays live while the heartbeat runs, and ages out without it', () => {
    expect(takeJudgeLock(archive)).toBe(true);
    const old = new Date(Date.now() - JUDGE_RUNNING_STALE_MS - 60_000);
    utimesSync(join(archive, 'judge.running'), old, old);
    expect(judgeRunning(archive), 'a crashed pass ages out').toBe(false);
    touchJudgeLock(archive);
    expect(judgeRunning(archive), 'a live one does not').toBe(true);
  });
});
