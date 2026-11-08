/**
 * Crash tests: real worker processes that die, hang, crash on import or are suspended, and the next
 * `supervise` call healing each. Workers are tiny scripts that use the real core.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { supervise, stderrPath, type JobSpec } from '../src/supervise/index.ts';
import { readLease, readRecord, releaseLease, takeLease, writeRecord } from '../src/supervise/record.ts';

const CORE = resolve('src/supervise/index.ts');
let root: string;
let archive: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'as-chaos-'));
  archive = join(root, 'archive');
  mkdirSync(archive);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (cond()) return;
  throw new Error('timed out waiting');
}
const exited = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

/** A worker script: claims the lease via `runJob`, then runs `body` (JS inside an async fn with `ctx`). */
function worker(name: string, body: string, deadlineMs = 60_000): string {
  const path = join(root, `${name}.ts`);
  writeFileSync(
    path,
    `import { runJob } from ${JSON.stringify(CORE)};
const archive = ${JSON.stringify(archive)};
await runJob(${JSON.stringify(name)}, archive, { deadlineMs: ${deadlineMs} }, async (ctx) => { ${body} });
process.exit(0);
`,
  );
  return path;
}

function spec(name: string, script: string, over: Partial<JobSpec> = {}): JobSpec {
  return {
    name,
    isDue: () => true,
    start: (env) => {
      const fd = stderrPath(archive, name);
      const child = spawn(process.execPath, ['--experimental-strip-types', script], {
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...env, NODE_NO_WARNINGS: '1' },
      });
      child.stderr?.on('data', (d) => {
        try {
          writeFileSync(fd, d, { flag: 'a' });
        } catch {
          // The test may already have removed the archive.
        }
      });
      child.unref();
      return child.pid;
    },
    deadlineMs: 60_000,
    staleMs: 60_000,
    bootGraceMs: 60_000,
    ...over,
  };
}

describe('the next supervise heals', () => {
  it('a worker that crashes on import: recorded with its reason, then backed off', async () => {
    const bad = join(root, 'bad.ts');
    writeFileSync(bad, `throw new Error('boom at import');\n`);
    const job = spec('j', bad);
    expect(supervise([job], { archive })['j']).toBe('start');
    const pid = readLease(archive, 'j')?.pid as number;
    await waitFor(() => exited(pid));
    await sleep(50);

    expect(supervise([job], { archive })['j']).toBe('backoff');
    const r = readRecord(archive, 'j');
    expect(r.failures).toBe(1);
    expect(r.lastEnd?.reason).toMatch(/never-started: .*boom at import/);
    expect(existsSync(stderrPath(archive, 'j')), 'read once, then deleted').toBe(false);

    // Past the back-off, one trial run is allowed.
    const later = Date.parse(r.retryAt as string) + 1;
    expect(supervise([job], { archive, now: later })['j']).toBe('start');
  });

  it('a worker killed mid-run: its dead pid is reclaimed at once', async () => {
    const job = spec('j', worker('j', `await new Promise(() => setInterval(() => {}, 1000));`));
    supervise([job], { archive });
    const pid = readLease(archive, 'j')?.pid as number;
    await waitFor(() => readLease(archive, 'j')?.startedAt !== undefined);
    process.kill(pid, 'SIGKILL');
    await waitFor(() => exited(pid));

    expect(supervise([job], { archive })['j']).toBe('backoff');
    expect(readRecord(archive, 'j').lastEnd?.reason).toMatch(/^died/);
    expect(readLease(archive, 'j')).toBeUndefined();
  });

  it('a hung worker ends itself at its deadline and records why', async () => {
    // A real hang keeps a handle open (a pipe, a timer); an empty promise would just let Node exit.
    const job = spec('j', worker('j', `await new Promise(() => setInterval(() => {}, 1000));`), { deadlineMs: 800 });
    supervise([job], { archive });
    const pid = readLease(archive, 'j')?.pid as number;
    await waitFor(() => exited(pid), 8000);

    expect(readRecord(archive, 'j').lastEnd?.reason).toBe('overran its deadline');
    expect(readLease(archive, 'j')).toBeUndefined();
    expect(supervise([job], { archive })['j']).toBe('backoff');
  });

  it('one failing job never stops another', () => {
    writeRecord(archive, 'judge', { failures: 9, paidFailures: 3, held: true });
    const ok = spec('standing', worker('standing', `return { status: 'ok' };`));
    const held = spec('judge', worker('judge', `return { status: 'ok' };`));
    expect(supervise([held, ok], { archive })).toEqual({ judge: 'held', standing: 'start' });
  });

  it('a success clears the record', async () => {
    writeRecord(archive, 'j', { failures: 3, paidFailures: 0, retryAt: new Date(0).toISOString() });
    const job = spec('j', worker('j', `return { status: 'ok' };`));
    supervise([job], { archive });
    await waitFor(() => readRecord(archive, 'j').lastEnd?.status === 'ok');
    expect(readRecord(archive, 'j').failures).toBe(0);
  });
});

describe('fencing: a suspended worker cannot act after its lease is gone', () => {
  it('is not reclaimed while alive, and writes nothing once superseded', async () => {
    const marker = join(root, 'wrote');
    const body = `await new Promise((r) => setTimeout(r, 400));
      if (ctx.holds()) (await import('node:fs')).writeFileSync(${JSON.stringify(marker)}, 'x');
      return { status: 'ok' };`;
    const job = spec('j', worker('j', body), { staleMs: 1, bootGraceMs: 1 });
    supervise([job], { archive });
    const pid = readLease(archive, 'j')?.pid as number;
    await waitFor(() => readLease(archive, 'j')?.startedAt !== undefined);
    process.kill(pid, 'SIGSTOP');
    await sleep(100);

    // Stale on every clock, but the process lives: the supervisor leaves it alone.
    expect(supervise([job], { archive, now: Date.now() + 10_000 })['j']).toBe('running');

    // Forced takeover by someone else, then the old worker wakes up.
    releaseLease(archive, 'j');
    const successor = takeLease(archive, 'j', 60_000);
    process.kill(pid, 'SIGCONT');
    await waitFor(() => exited(pid));

    expect(existsSync(marker), 'the superseded worker wrote nothing').toBe(false);
    expect(readLease(archive, 'j')?.token, "and did not free its successor's lease").toBe(successor?.token);
  });
});

describe('the real judge pass, against a fake claude', () => {
  it('holds after repeated paid failures, so an unreadable reply cannot bill on a loop', () => {
    const projects = join(root, 'projects', '-Users-x-app');
    mkdirSync(projects, { recursive: true });
    const lines = [
      { type: 'user', uuid: 'u', sessionId: 's0', timestamp: '2026-10-20T10:00:00.000Z', version: '2.1.296', message: { role: 'user', content: 'word '.repeat(300) } },
      { type: 'assistant', uuid: 'a', sessionId: 's0', timestamp: '2026-10-20T10:00:05.000Z', version: '2.1.296', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    ];
    writeFileSync(join(projects, 's0.jsonl'), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const calls = join(root, 'calls');
    writeFileSync(
      join(bin, 'claude'),
      `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(calls)}, 'x');
process.stdin.resume();
process.stdin.on('end', () => process.stdout.write(JSON.stringify({ result: 'this is not json', usage: { input_tokens: 10, output_tokens: 1 } })));
`,
    );
    chmodSync(join(bin, 'claude'), 0o755);
    writeFileSync(join(archive, 'judge-settings.json'), JSON.stringify({ enabled: true, model: 'haiku', cadence: 50, maxBatchTokens: 60_000, concurrency: 3 }));

    const env = { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}`, VIBESENPAI_SOURCES: join(root, 'projects'), VIBESENPAI_ARCHIVE: archive, NODE_NO_WARNINGS: '1' };
    for (let i = 0; i < 6; i += 1) {
      // Each run as the supervisor would after its back-off: clear `retryAt`, keep the counts.
      const { retryAt: _skip, ...r } = readRecord(archive, 'judge');
      if (r.held === true) break;
      writeRecord(archive, 'judge', r);
      spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/judge.ts'], { env, timeout: 30_000 });
    }

    const r = readRecord(archive, 'judge');
    expect(r.held, 'held after the paid limit').toBe(true);
    expect(r.lastEnd?.kind).toBe('paid');
    expect(r.lastEnd?.reason).toMatch(/could not be read/);
    expect(readFileSync(calls, 'utf8').length, 'three paid calls, no more').toBe(3);
  });
});

