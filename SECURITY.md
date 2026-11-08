# Security

## Reporting

Please report security issues privately via
[GitHub Security Advisories](https://github.com/vibesenpai/vibesenpai/security/advisories/new)
rather than a public issue.

Include what you ran, what happened, and what you expected. If it involves data
leaving the machine, say which version and whether the judge was enabled.

## What this tool touches

| | |
|---|---|
| **reads** | `~/.claude/projects/**`, in place — never modified, never copied |
| **writes** | `~/.local/share/vibesenpai`, mode 0600 |
| **writes, with consent** | `~/.claude/settings.json` via `vibesenpai install`, which prints the change, requires `--apply`, and takes a backup |
| **sends** | nothing, unless the judge is explicitly enabled |

## The judge, which is the part that matters

The judge is **on from installation** and sends redacted transcript text to a
model through your own Claude Code CLI — but **only when you run a command.**
The `Stop` hook does not spawn a pass, which is what keeps nothing unprompted;
`test/spend-boundary.test.ts` asserts it.

**Redaction is asserted, not attempted.** Immediately before every call the
packet is checked, and the send is **aborted** if redaction would still change
anything. Measured across the corpus, 50% of real sessions carry secret-shaped
content at the fidelity the judge reads — API keys, JWTs, bearer tokens, URL
credentials — and tool output is where it concentrates.

The check is `redact(packet) === packet`, not "redacting twice gives the same
result". The second is weaker, and this project got that distinction wrong once.

## Kill switch

```bash
VIBESENPAI_DISABLE=1
```

Checked on the first line of every entry point, including the installed hooks.
Nothing reads, nothing runs, nothing sends.

## Known limits

A `permissions.deny` rule suggested by `vibesenpai fix` is **not a security
boundary**, and the tool says so when it suggests one. Claude Code's own
documentation says the same. A rule written for `pnpm add` does not match
`npx pnpm add` or `sh -c 'pnpm add'`.

Findings are evidence anchored to turns, not verdicts. Treat them as a reason to
look.
