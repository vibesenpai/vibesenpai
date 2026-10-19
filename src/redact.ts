/**
 * Redaction. Runs before anything is stored or displayed.
 *
 * This module carries more weight than it looks. Because we keep no transcript
 * copies, **what we persist is the only version that will exist** — there is no
 * raw fallback to re-derive from if redaction turns out to be wrong. Secrets
 * must not get through, and evidence must not be destroyed on the way.
 *
 * ── The tension that shapes every rule below ─────────────────────────────────
 *
 * Over-redaction is not the safe side. A findings tool whose evidence reads
 * `[REDACTED] [REDACTED] at [REDACTED]` is useless, and uselessness is the
 * failure we are actually trying to avoid. So the rules are built around a
 * split:
 *
 *   KEEP   — commands, relative paths, error text, tool names, git SHAs,
 *            tool_use ids. These are the evidence.
 *   REMOVE — things that are secret *by construction*: provider-prefixed
 *            tokens, PEM blocks, assignments to secret-named variables,
 *            bearer values, JWTs, emails, and the username inside absolute
 *            paths.
 *
 * Deliberately NOT redacted: bare high-entropy strings. A 40-character hex
 * string is far more often a git SHA than a secret, and a UUID is almost always
 * a `tool_use_id`. Redacting on entropy alone would strip the identifiers that
 * findings point at. High-entropy values are removed only in a *secret context*
 * — after `=` on a secret-named key, after `Bearer`, inside a known prefix.
 *
 * Reference bar: SWE-chat redacted its public corpus with Microsoft Presidio
 * plus TruffleHog. We are narrower on purpose (no ML, no network), so the rules
 * below are explicit and testable rather than probabilistic.
 */

import { homedir } from 'node:os';

export type RedactionKind =
  | 'private-key'
  | 'api-key'
  | 'jwt'
  | 'secret-assignment'
  | 'bearer'
  | 'url-credentials'
  | 'email'
  | 'home-path'
  | 'user-path';

export type RedactResult = {
  text: string;
  /** What was removed, by kind. Empty when nothing matched. */
  redactions: Partial<Record<RedactionKind, number>>;
  /** True when anything at all was removed — cheap check for callers. */
  redacted: boolean;
};

type Rule = {
  kind: RedactionKind;
  pattern: RegExp;
  /** Replacement. May use capture groups to preserve surrounding evidence. */
  replace: string | ((...m: string[]) => string);
};

const TOKEN = (k: RedactionKind): string => `[REDACTED:${k}]`;

/**
 * Variable names whose value is secret regardless of what it looks like. This
 * is what lets us remove a low-entropy password like `hunter2` — entropy rules
 * never would.
 */
const SECRET_KEY =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|API_KEY|APIKEY|AUTH)[A-Z0-9_]*)\b/i;

/**
 * Order matters. Multi-line structures first, then contextual rules, then
 * standalone shapes, then paths last so earlier rules still see full paths.
 */
const RULES: Rule[] = [
  // PEM blocks — multi-line, so they must be removed before anything splits lines.
  {
    kind: 'private-key',
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: TOKEN('private-key'),
  },

  // Provider-prefixed tokens. Secret by construction: the prefix IS the tell,
  // so no entropy heuristic is needed and no false positives on SHAs.
  {
    kind: 'api-key',
    pattern: new RegExp(
      [
        'sk-ant-[A-Za-z0-9_-]{16,}', // Anthropic
        'sk-[A-Za-z0-9_-]{20,}', // OpenAI and lookalikes
        'gh[pousr]_[A-Za-z0-9]{16,}', // GitHub classic
        'github_pat_[A-Za-z0-9_]{20,}', // GitHub fine-grained
        'xox[baprs]-[A-Za-z0-9-]{10,}', // Slack
        '(?:AKIA|ASIA)[A-Z0-9]{16}', // AWS access key id
        'AIza[A-Za-z0-9_-]{30,}', // Google
        'm0-[A-Za-z0-9]{20,}', // Mem0
        'glpat-[A-Za-z0-9_-]{16,}', // GitLab
        'npm_[A-Za-z0-9]{30,}', // npm
        'dop_v1_[a-f0-9]{60,}', // DigitalOcean
        'shpat_[a-f0-9]{30,}', // Shopify
        // Added after a bare `hf_…` token survived into an Event during this
        // project's own work — it was caught only when assigned to a *TOKEN*
        // variable, so one pasted into a prompt would have persisted.
        'hf_[A-Za-z0-9]{20,}', // HuggingFace
        '(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}', // Stripe secret/restricted
        'SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}', // SendGrid
        'r8_[A-Za-z0-9]{20,}', // Replicate
        'ya29\\.[A-Za-z0-9_-]{20,}', // Google OAuth access token
      ].join('|'),
      'g',
    ),
    replace: TOKEN('api-key'),
  },

  // JWTs — three base64url segments. `eyJ` is the b64 of `{"`, so this is shape
  // based rather than entropy based.
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: TOKEN('jwt'),
  },

  // Credentials embedded in a URL. The host is kept — it is often the evidence.
  {
    kind: 'url-credentials',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
    replace: (_m, scheme: string) => `${scheme}${TOKEN('url-credentials')}@`,
  },

  // Authorization headers and bearer values.
  {
    kind: 'bearer',
    pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    replace: (_m, scheme: string) => `${scheme} ${TOKEN('bearer')}`,
  },

  // Assignment to a secret-named variable. Keeps the KEY — which is evidence,
  // e.g. "the agent echoed ANTHROPIC_API_KEY" — and removes only the value.
  {
    kind: 'secret-assignment',
    // The negative lookahead keeps this rule off auth *schemes*. `Authorization`
    // matches SECRET_KEY via "AUTH", and without it the rule would consume
    // `Bearer` as the value — destroying evidence the bearer rule just preserved,
    // and double-redacting a line that was already safe.
    pattern: new RegExp(
      `${SECRET_KEY.source}(\\s*[:=]\\s*)(?!(?:Bearer|Basic|Token)\\b)` +
        `(?:"([^"]*)"|'([^']*)'|([^\\s,;}]+))`,
      'gi',
    ),
    replace: (_m, key: string, sep: string) => `${key}${sep}${TOKEN('secret-assignment')}`,
  },

  {
    kind: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replace: TOKEN('email'),
  },
];

/**
 * Paths are handled separately from the rule table because the home directory is
 * only known at call time, and because the transform is a *rewrite* rather than
 * a removal: the path structure is evidence (which file was edited) while the
 * username is not.
 */
function redactPaths(
  text: string,
  home: string,
  tally: (k: RedactionKind) => void,
): string {
  let out = text;

  if (home !== '') {
    // The caller's own home → `~`. Keeps `~/Workspace/app/src/auth.ts` readable.
    const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), () => {
      tally('home-path');
      return '~';
    });
  }

  // Any other user's home directory — macOS, Linux, Windows.
  out = out.replace(
    /(\/Users\/|\/home\/|[A-Z]:\\Users\\)([^/\\\s"']+)/g,
    (_m, prefix: string) => {
      tally('user-path');
      return `${prefix}[USER]`;
    },
  );

  return out;
}

export type RedactOptions = {
  /** Defaults to the real home directory. Injected in tests. */
  home?: string;
};

export function redact(text: string, opts: RedactOptions = {}): RedactResult {
  const home = opts.home ?? homedir();
  const redactions: Partial<Record<RedactionKind, number>> = {};
  const tally = (k: RedactionKind): void => {
    redactions[k] = (redactions[k] ?? 0) + 1;
  };

  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (...args: unknown[]) => {
      const whole = args[0] as string;
      // A match that already contains a replacement token was handled by an
      // earlier, more specific rule. Leaving it alone is what makes redaction
      // idempotent by construction rather than by luck.
      if (whole.includes('[REDACTED:')) return whole;
      tally(rule.kind);
      return typeof rule.replace === 'string'
        ? rule.replace
        : rule.replace(...(args as string[]));
    });
  }

  out = redactPaths(out, home, tally);

  return { text: out, redactions, redacted: Object.keys(redactions).length > 0 };
}

/**
 * Convenience for the common case. Named so that a caller storing text cannot
 * plausibly claim they did not know redaction was required.
 */
export function redactForStorage(text: string, opts?: RedactOptions): string {
  return redact(text, opts).text;
}

/**
 * Idempotence check, used in tests and assertable in CI.
 *
 * Redacting twice must equal redacting once. If it does not, a replacement
 * token is itself matching a rule — which would corrupt text on a second pass
 * and, worse, make the output depend on how many times it had been handled.
 */
export function isIdempotent(text: string, opts?: RedactOptions): boolean {
  const once = redact(text, opts).text;
  return redact(once, opts).text === once;
}
