import { describe, expect, it } from 'vitest';
import { redact, isIdempotent } from '../src/redact.ts';

const H = '/Users/testuser';
const r = (s: string) => redact(s, { home: H });

describe('redact — planted secrets', () => {
  // Strings that must never reach the store.
  const planted: [string, string][] = [
    ['anthropic', 'sk-ant-api03-AbCdEf1234567890xyzAbCdEf'],
    ['openai', 'sk-proj-abcdefghijklmnopqrstuvwxyz0123'],
    ['github classic', 'ghp_AbCdEf1234567890AbCdEf1234567890'],
    ['github fine-grained', 'github_pat_11ABCDEFG0abcdefghijkl_mnopqrs'],
    ['slack', 'xoxb-1234567890-abcdefghijkl'],
    ['aws', 'AKIAIOSFODNN7EXAMPLE'],
    ['google', 'AIzaSyA1234567890abcdefghijklmnopqrstu'],
    ['mem0', 'm0-abcdefghijklmnopqrstuvwxyz'],
    ['gitlab', 'glpat-AbCdEf1234567890xy'],
    // A bare token, not only one assigned to a TOKEN variable.
    ['huggingface', 'hf_AbCdEfGhIjKlMnOpQrStUvWxYz012345'],
    ['stripe', 'sk_live_AbCdEf1234567890xyz'],
    ['sendgrid', 'SG.AbCdEf1234567890xy.AbCdEf1234567890xyz'],
    ['replicate', 'r8_AbCdEfGhIjKlMnOpQrStUv123'],
    ['google oauth', 'ya29.AbCdEfGhIjKlMnOpQrStUvWx'],
  ];

  for (const [name, secret] of planted) {
    it(`removes a ${name} key`, () => {
      const out = r(`running with ${secret} now`);
      expect(out.text).not.toContain(secret);
      expect(out.text).toContain('[REDACTED:api-key]');
      expect(out.redactions['api-key']).toBe(1);
    });
  }

  it('removes a PEM private key block across lines', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAxyz1234567890',
      'abcdefghijklmnopqrstuvwxyz==',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = r(`here it is:\n${pem}\ndone`);
    expect(out.text).not.toContain('MIIEow');
    expect(out.text).toContain('[REDACTED:private-key]');
    expect(out.text).toContain('done'); // surrounding text survives
  });

  it('removes a JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r';
    const out = r(`Authorization failed for ${jwt}`);
    expect(out.text).not.toContain('eyJhbGci');
    expect(out.redactions['jwt']).toBe(1);
  });

  it('removes credentials from a URL but keeps the host', () => {
    const out = r('cloning https://alice:hunter2@github.com/acme/repo.git');
    expect(out.text).not.toContain('hunter2');
    expect(out.text).toContain('github.com/acme/repo.git');
  });

  it('removes a bearer value but keeps the scheme', () => {
    const out = r('curl -H "Authorization: Bearer abcdef1234567890xyz"');
    expect(out.text).not.toContain('abcdef1234567890xyz');
    expect(out.text).toContain('Bearer [REDACTED:bearer]');
  });

  it('removes an email address', () => {
    const out = r('author me@example.com committed');
    expect(out.text).not.toContain('me@example.com');
    expect(out.redactions['email']).toBe(1);
  });
});

describe('redact — secret assignments, where entropy rules fail', () => {
  it('removes a LOW-entropy password that no entropy heuristic would catch', () => {
    const out = r('DB_PASSWORD=hunter2');
    expect(out.text).not.toContain('hunter2');
    expect(out.text).toBe('DB_PASSWORD=[REDACTED:secret-assignment]');
  });

  it('keeps the key name, because the key is itself evidence', () => {
    // "the agent echoed ANTHROPIC_API_KEY" is a finding; the value is not.
    const out = r('ANTHROPIC_API_KEY="sk-whatever-this-is"');
    expect(out.text).toContain('ANTHROPIC_API_KEY');
    expect(out.text).not.toContain('sk-whatever-this-is');
  });

  it('handles quoted, unquoted and colon-separated forms', () => {
    for (const form of [
      'SECRET=plain',
      "SECRET='single'",
      'SECRET="double"',
      'SECRET: yaml',
    ]) {
      const out = r(form);
      expect(out.text).toContain('[REDACTED:secret-assignment]');
      expect(out.text).toMatch(/^SECRET/);
    }
  });

  it('leaves a non-secret assignment completely alone', () => {
    const out = r('NODE_ENV=production');
    expect(out.text).toBe('NODE_ENV=production');
    expect(out.redacted).toBe(false);
  });
});

describe('redact — evidence must survive', () => {
  // Over-redaction is not the safe side: evidence must survive.
  const keep = [
    ['a shell command', 'npm install lodash'],
    ['a pnpm violation — the actual finding', 'npm run build'],
    ['a relative path', 'src/auth.ts'],
    ['error text', 'TypeError: token is undefined'],
    ['a test result', 'Tests: 3 failed, 12 passed'],
    ['a tool name', 'Bash'],
    ['a git SHA — not a secret, and it is evidence', '4d8cc73a1b3e4305f8155aefe476a409c7b2d1e0'],
    ['a tool_use id', 'toolu_018DJ5iyyh4QStvwGePpR2qy'],
    ['a UUID', 'e3a3f0d4-a1b3-4305-8f15-5aefe476a409'],
    ['a version string', 'claude-code 2.1.296'],
    ['a port and host', 'listening on localhost:3000'],
  ];

  for (const [name, text] of keep) {
    it(`keeps ${name}`, () => {
      const out = r(text as string);
      expect(out.text).toBe(text);
      expect(out.redacted).toBe(false);
    });
  }

  it('keeps a full failing-test window intact', () => {
    const window = [
      'U: fix the login bug',
      'Bash: npm test',
      'Exit code 1',
      'FAIL src/auth.test.ts > rejects an expired token',
      'Edit src/auth.ts (60 lines)',
    ].join('\n');
    expect(r(window).text).toBe(window);
  });
});

describe('redact — paths keep structure, lose identity', () => {
  it("rewrites the caller's home to ~, keeping the path readable", () => {
    const out = r(`edited ${H}/Workspace/app/src/auth.ts`);
    expect(out.text).toBe('edited ~/Workspace/app/src/auth.ts');
    expect(out.redactions['home-path']).toBe(1);
  });

  it("masks another user's home directory", () => {
    const out = r('reading /Users/someoneelse/secrets/notes.md');
    expect(out.text).toBe('reading /Users/[USER]/secrets/notes.md');
  });

  it('masks a Linux home and a Windows profile', () => {
    expect(r('/home/bob/project').text).toBe('/home/[USER]/project');
    expect(r('C:\\Users\\bob\\project').text).toBe('C:\\Users\\[USER]\\project');
  });

  it('leaves system paths alone — they are not identifying', () => {
    for (const p of ['/usr/local/bin/node', '/tmp/build.log', '/etc/hosts']) {
      expect(r(p).text).toBe(p);
    }
  });
});

describe('redact — safety properties', () => {
  it('is idempotent: redacting twice equals redacting once', () => {
    // A replacement token must not match a rule.
    const messy = [
      'sk-ant-api03-AbCdEf1234567890xyz',
      'PASSWORD=hunter2',
      `${H}/x/y.ts`,
      'me@example.com',
      'Bearer abcdef1234567890xyz',
    ].join(' | ');
    expect(isIdempotent(messy, { home: H })).toBe(true);
  });

  it('never leaves the secret in the output when several kinds collide', () => {
    const out = r(
      `AWS_SECRET_ACCESS_KEY=abc123 and AKIAIOSFODNN7EXAMPLE at ${H}/a.ts for me@x.io`,
    );
    for (const secret of ['abc123', 'AKIAIOSFODNN7EXAMPLE', 'testuser', 'me@x.io']) {
      expect(out.text).not.toContain(secret);
    }
    expect(out.text).toContain('a.ts'); // evidence survives
  });

  it('reports what it removed, so callers can assert rather than hope', () => {
    const out = r('sk-ant-api03-AbCdEf1234567890xyz and PASSWORD=x1 and me@x.io');
    expect(out.redactions).toMatchObject({
      'api-key': 1,
      'secret-assignment': 1,
      email: 1,
    });
    expect(out.redacted).toBe(true);
  });

  it('handles empty and whitespace input without throwing', () => {
    expect(r('').text).toBe('');
    expect(r('   \n  ').redacted).toBe(false);
  });

  it('does not alter text containing no secrets at all', () => {
    const clean = 'U: it is still broken\nEdit auth.ts (55 lines, ~80% similar)';
    expect(r(clean).text).toBe(clean);
  });
});
