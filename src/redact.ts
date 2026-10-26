/**
 * Redaction, run before anything is stored, displayed or sent to a model. What we persist is the only copy.
 * Removes what is secret by construction (prefixed tokens, PEM, secret-named assignments, bearer, JWT,
 * email, usernames in paths). Keeps evidence: commands, paths, SHAs, ids. Never redacts on entropy alone.
 */

import { homedir } from 'node:os';

type RedactionKind =
  | 'private-key'
  | 'api-key'
  | 'jwt'
  | 'secret-assignment'
  | 'bearer'
  | 'url-credentials'
  | 'email'
  | 'home-path'
  | 'user-path';

type RedactResult = {
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

/** Variable names whose value is secret whatever it looks like (catches `hunter2`). */
const SECRET_KEY =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|API_KEY|APIKEY|AUTH)[A-Z0-9_]*)\b/i;

/** Order matters: multi-line first, then contextual, then standalone shapes; paths last. */
const RULES: Rule[] = [
  // PEM blocks — multi-line, so they must be removed before anything splits lines.
  {
    kind: 'private-key',
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: TOKEN('private-key'),
  },

  // Provider-prefixed tokens: the prefix is the tell, so no entropy heuristic.
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

  // JWTs: three base64url segments starting `eyJ`.
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

  // Assignment to a secret-named variable: keeps the key (evidence), removes the value.
  {
    kind: 'secret-assignment',
    // The lookahead skips auth schemes, so `Authorization: Bearer` is left to the bearer rule.
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

/** Paths are rewritten, not removed: home becomes `~`, other usernames `[USER]`. Home is known only at call time. */
function redactPaths(
  text: string,
  home: string,
  tally: (k: RedactionKind) => void,
): string {
  let out = text;

  if (home !== '') {
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

type RedactOptions = {
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
      // Skip matches already holding a token, so redaction is idempotent by construction.
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

/** Redacting twice must equal redacting once. Tests only: the send gate uses strict equality instead. */
export function isIdempotent(text: string, opts?: RedactOptions): boolean {
  const once = redact(text, opts).text;
  return redact(once, opts).text === once;
}
