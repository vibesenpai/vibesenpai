import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  commandKey,
  didExecute,
  hasVerdictShape,
  learn,
  lookupFor,
  emptyRegistry,
  readRegistry,
  writeRegistry,
  staticLookup,
  coldLookup,
  type VerificationRegistry,
} from '../src/verify.ts';
import { SCHEMA } from '../src/schema.ts';
import type { Event } from '../src/types.ts';

let seq = 0;
function ev(over: Partial<Event> & Pick<Event, 'turnType'>): Event {
  seq += 1;
  return {
    sessionId: 's1',
    harness: 'claude-code',
    uuid: `u${seq}`,
    parentUuid: null,
    seq: over.seq ?? seq,
    isSidechain: false,
    ts: '2026-10-19T00:00:00.000Z',
    ...over,
  } as Event;
}
const call = (command: string): Event => ev({ turnType: 'tool_use', toolName: 'Bash', command });
const out = (textSummary: string, failed = false): Event =>
  ev({ turnType: 'tool_result', textSummary, ...(failed ? { isError: true } : { exitCode: 0 }) });

const NOW = '2026-10-19T00:00:00.000Z';

describe('commandKey — find the verb, not the prefix', () => {
  it('strips a cd prefix, which was the most common "command" in the probe', () => {
    // A three-word key turned this into `cd ~/project`, the top row of the
    // measured output.
    expect(commandKey('cd ~/project && npx vitest run')).toBe('npx vitest run');
  });

  it('peels several prefixes at once', () => {
    expect(commandKey('cd /app && CI=1 time pytest -q tests/')).toBe('pytest tests/');
  });

  it('reduces an executable path to the tool it is', () => {
    // Same tool invoked by different paths must key the same, or the registry
    // learns the same thing three times and confirms none of it.
    expect(commandKey('./node_modules/.bin/vitest run')).toBe('vitest run');
    expect(commandKey('tooling/sanitizer/.venv/bin/pytest tests/')).toBe('pytest tests/');
  });

  it('keeps the arguments that identify a task runner target', () => {
    expect(commandKey('mise run test:ci')).toBe('mise run test:ci');
    expect(commandKey('uv run pyright')).toBe('uv run pyright');
  });

  it('drops redirections and anything chained after', () => {
    expect(commandKey('npm test 2>&1 | tail -5')).toBe('npm test');
    expect(commandKey('go build ./... && go test ./...')).toBe('go build ./...');
  });

  it('ignores a heredoc body', () => {
    // The point is that it does not key as `npm test` from the body.
    expect(commandKey("cat > t.md <<'EOF'\nnpm test\nEOF")).toBe('cat');
  });

  it('returns undefined when there is nothing to key', () => {
    expect(commandKey(undefined)).toBeUndefined();
    expect(commandKey('   ')).toBeUndefined();
  });
});

describe('didExecute — reading a test is not running one', () => {
  it('accepts a command that ran', () => {
    expect(didExecute(call('pytest -q'))).toBe(true);
  });

  it('rejects a tool with no command at all', () => {
    // The measured false positives: Read of a test file, grep for `expect(`,
    // WebFetch of a page about testing — all matched verdict vocabulary.
    expect(didExecute(ev({ turnType: 'tool_use', toolName: 'Read', filePath: 'a.test.ts' }))).toBe(false);
    expect(didExecute(ev({ turnType: 'tool_use', toolName: 'WebSearch' }))).toBe(false);
  });

  it('rejects a command that writes a file and echoes it', () => {
    expect(didExecute(call("cat >> test/a.test.ts <<'EOF'\nexpect(x).toBe(1)\nEOF"))).toBe(false);
    expect(didExecute(call('echo "1 passed" > log.txt'))).toBe(false);
  });
});

describe('hasVerdictShape — vocabulary that spans frameworks', () => {
  const verdicts = [
    ['vitest', 'Test Files 2 passed (2) Tests 29 passed (29)'],
    ['pytest', '.s................... [100%] 33 passed, 1 skipped'],
    ['go test', 'ok github.com/acme/cli/checkpoint 0.264s'],
    ['jest', 'PASS src/shares/shares.service.spec.ts'],
    ['TAP', 'ok 1 - the server advertises private_key_jwt'],
    ['pyright', '0 errors, 0 warnings, 0 informations'],
    ['tsc-ish', 'Tests: 3 failed, 9 passed'],
    ['assertion', 'AssertionError: expected 2 to be 3'],
    ['go panic', 'panic: runtime error: index out of range'],
    ['tick lines', '  ✓ test/parser.test.ts (15 tests)'],
    ['build', 'Build failed with 2 errors'],
  ];
  for (const [name, text] of verdicts) {
    it(`recognises ${name}`, () => {
      expect(hasVerdictShape(text as string), text as string).toBe(true);
    });
  }

  const notVerdicts = [
    ['a directory listing', 'total 64 drwxr-xr-x 10 user staff 320 Oct 18 20:23 .'],
    ['a git log', '5db6b2a Use <TAB> instead of a real TAB in examples'],
    ['a diff', '+++ b/src/a.ts @@ -1,4 +1,6 @@ export const x = 1;'],
    ['empty output', ''],
  ];
  for (const [name, text] of notVerdicts) {
    it(`does not recognise ${name}`, () => {
      expect(hasVerdictShape(text as string), text as string).toBe(false);
    });
  }
});

describe('learn — a verification command is one whose verdict varies', () => {
  it('records a command on first sighting at `high`', () => {
    const r = learn(emptyRegistry(), [call('pytest -q'), out('12 passed')], 'proj', NOW);
    const e = Object.values(r.entries)[0]!;
    expect(e.command).toBe('pytest'); // flags are not part of identity
    expect(e.confidence).toBe('high');
    expect(e.pass).toBe(1);
  });

  it('upgrades to `certain` once it has both passed and failed', () => {
    // This is the framework-agnostic core: the verdict responds to the code.
    let r = learn(emptyRegistry(), [call('pytest -q'), out('12 passed')], 'proj', NOW);
    r = learn(r, [call('pytest -q'), out('2 failed, 10 passed', true)], 'proj', NOW);
    const e = Object.values(r.entries)[0]!;
    expect(e.confidence).toBe('certain');
    expect(e.pass).toBe(1);
    expect(e.fail).toBe(1);
  });

  it('learns nothing from output with no verdict', () => {
    const r = learn(emptyRegistry(), [call('git status'), out('On branch main')], 'proj', NOW);
    expect(Object.keys(r.entries)).toHaveLength(0);
  });

  it('learns nothing from a tool that did not execute', () => {
    const r = learn(
      emptyRegistry(),
      [ev({ turnType: 'tool_use', toolName: 'Read', filePath: 'a.test.ts' }), out('✓ 3 passed')],
      'proj',
      NOW,
    );
    expect(Object.keys(r.entries)).toHaveLength(0);
  });

  it('keeps projects separate', () => {
    let r = learn(emptyRegistry(), [call('pytest'), out('1 passed')], 'alpha', NOW);
    r = learn(r, [call('go test ./...'), out('ok acme 0.1s')], 'beta', NOW);
    expect(lookupFor(r, 'alpha', { requireConfirmed: false }).isVerification('pytest')).toBe(true);
    expect(lookupFor(r, 'beta', { requireConfirmed: false }).isVerification('pytest')).toBe(false);
  });
});

describe('lookupFor — confirmation is required before a finding', () => {
  const twice = (): ReturnType<typeof emptyRegistry> => {
    let r = learn(emptyRegistry(), [call('pytest'), out('3 passed')], 'proj', NOW);
    r = learn(r, [call('pytest'), out('1 failed', true)], 'proj', NOW);
    return r;
  };

  it('trusts a confirmed command', () => {
    expect(lookupFor(twice(), 'proj').isVerification('pytest -q')).toBe(true);
  });

  it('does NOT trust shape alone by default', () => {
    // `git log --oneline` matched on shape once across 253 sessions. A `certain`
    // detector cannot rest on that.
    const r = learn(emptyRegistry(), [call('git log --oneline'), out('ok 1 thing')], 'proj', NOW);
    expect(lookupFor(r, 'proj').isVerification('git log --oneline')).toBe(false);
    expect(lookupFor(r, 'proj', { requireConfirmed: false }).isVerification('git log --oneline')).toBe(true);
  });

  it('reports a cold project rather than guessing', () => {
    const l = lookupFor(emptyRegistry(), 'proj');
    expect(l.cold).toBe(true);
    expect(l.known).toBe(0);
    expect(l.isVerification('npm test')).toBe(false);
  });

  it('keys overrides by project, with no control character for a human to type', () => {
    // The first version shared the NUL-joined internal key, so a hand-written
    // override silently never matched.
    const r: VerificationRegistry = {
      ...emptyRegistry(),
      overrides: { proj: { 'npm test': 'include' } },
    };
    expect(JSON.stringify(r.overrides)).not.toContain('\\u0000');
    expect(lookupFor(r, 'proj').isVerification('npm test')).toBe(true);
  });

  it('lets an explicit include override the cold start', () => {
    const r: VerificationRegistry = {
      ...emptyRegistry(),
      overrides: { proj: { 'npm test': 'include' } },
    };
    expect(lookupFor(r, 'proj').isVerification('npm test')).toBe(true);
  });

  it('lets an explicit exclude beat anything learned', () => {
    const r: VerificationRegistry = { ...twice(), overrides: { proj: { pytest: 'exclude' } } };
    expect(lookupFor(r, 'proj').isVerification('pytest')).toBe(false);
  });
});

describe('registry persistence', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentsensei-verify-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips what was learned, so session 2 knows it', () => {
    const r = learn(emptyRegistry(), [call('pytest'), out('3 passed')], 'proj', NOW);
    writeRegistry(dir, r);
    expect(Object.keys(readRegistry(dir).entries)).toHaveLength(1);
  });

  it('is self-describing and versioned on disk', () => {
    writeRegistry(dir, emptyRegistry());
    const raw = JSON.parse(readFileSync(join(dir, 'verification.json'), 'utf8'));
    expect(raw).toMatchObject({ tool: 'agentsensei', schema: 'verification', v: SCHEMA.verification });
  });

  it('re-derives rather than trusting a newer schema', () => {
    const r = learn(emptyRegistry(), [call('pytest'), out('3 passed')], 'proj', NOW);
    writeRegistry(dir, { ...r, v: (SCHEMA.verification + 1) as 1 });
    // A bump costs a cold start, never wrong findings.
    expect(Object.keys(readRegistry(dir).entries)).toHaveLength(0);
  });

  it('survives a corrupt file with a cold start', () => {
    writeRegistry(dir, emptyRegistry());
    rmSync(join(dir, 'verification.json'));
    expect(readRegistry(dir).entries).toEqual({});
  });
});

describe('staticLookup — the override path, not the mechanism', () => {
  it('normalises its own list the same way', () => {
    const l = staticLookup(['npm test']);
    expect(l.isVerification('cd /app && npm test 2>&1')).toBe(true);
  });

  it('is cold when empty', () => {
    expect(staticLookup([]).cold).toBe(true);
    expect(coldLookup().cold).toBe(true);
  });
});

describe('commandKey — multi-line scripts', () => {
  it('skips a setup-only line to find the real command', () => {
    // `cd ~/Workspace/agentsensei` became the most frequently "confirmed"
    // verification command in the corpus, because it sat alone on line 1.
    expect(commandKey('cd ~/Workspace/agentsensei\nnpx vitest run')).toBe('npx vitest run');
  });

  it('skips several setup lines', () => {
    expect(commandKey('cd /app\nexport CI=1\nsource .venv/bin/activate\npytest tests/')).toBe(
      'pytest tests/',
    );
  });

  it('returns undefined when the script only sets up', () => {
    expect(commandKey('cd /app\nexport CI=1')).toBeUndefined();
  });
});

describe('commandKey — a cd target that contains spaces', () => {
  it('skips `cd "$(git rev-parse …)"` on its own line', () => {
    // A quoted or substituted target has spaces, so a bare \S+ did not match it
    // and the cd line became the command.
    expect(commandKey('cd "$(git rev-parse --show-toplevel)"\nnpm test')).toBe('npm test');
  });

  it('strips it inline too', () => {
    expect(commandKey('cd "$(git rev-parse --show-toplevel)" && go test ./...')).toBe(
      'go test ./...',
    );
  });
});

describe('outHash — comparing full output, not a 200-char prefix', () => {
  it('separates two results that share a long prefix', async () => {
    // `textSummary` is capped at 200 chars and 59.9% of 3,748 real results hit
    // that cap, so comparing summaries compared prefixes: two different
    // failures with the same opening line looked identical.
    const prefix = 'FAIL '.repeat(45); // > 200 chars
    const { outputDigest } = await import('../src/normalise.ts');
    const a = outputDigest(`${prefix}expected 2 to be 3`);
    const b = outputDigest(`${prefix}expected 7 to be 9`);
    expect(a).toBeDefined();
    expect(a).not.toBe(b);
  });

  it('still collapses output differing only in volatile parts', async () => {
    const { outputDigest } = await import('../src/normalise.ts');
    expect(outputDigest('FAIL auth.ts:42 token undefined in 1.2s')).toBe(
      outputDigest('FAIL auth.ts:51 token undefined in 0.9s'),
    );
  });

  it('preserves counts, so falling failures are not one value', async () => {
    const { outputDigest } = await import('../src/normalise.ts');
    expect(outputDigest('Tests: 3 failed, 9 passed')).not.toBe(
      outputDigest('Tests: 1 failed, 11 passed'),
    );
  });

  it('returns undefined for empty output, which tells a detector nothing', async () => {
    const { outputDigest } = await import('../src/normalise.ts');
    expect(outputDigest('')).toBeUndefined();
    expect(outputDigest('   ')).toBeUndefined();
    expect(outputDigest(undefined)).toBeUndefined();
  });
});
