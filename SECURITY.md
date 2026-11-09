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
| **never writes** | your project files or `~/.claude/settings.json`; a fix is a request the developer approves in Claude Code |
| **sends** | redacted session text to Claude Haiku through your own Claude Code login, from the `Stop` hook, within 2M tokens a day; `/vibesenpai:judge off` stops it |

## The judge, which is the part that matters

The judge is **on from installation**, after a one-time notice at session start.
It runs detached from the `Stop` hook only, never from session start, within a
daily token limit; `test/spend-boundary.spec.ts` asserts that boundary. Session
text includes what the agent's tools returned, so code and command output from
a session can be part of what is sent.

**Redaction is asserted, not attempted.** Immediately before every call the
packet is checked, and the send is **aborted** if redaction would still change
anything. Secret-shaped content — API keys, JWTs, bearer tokens, URL
credentials — concentrates in tool output.

The check is `redact(packet) === packet`, not "redacting twice gives the same
result". The second is weaker, and this project got that distinction wrong once.

## Kill switch

```bash
VIBESENPAI_DISABLE=1
```

Checked on the first line of every entry point, including the installed hooks.
Nothing reads, nothing runs, nothing sends.

## Known limits

A permission rule suggested as a fix (`permissions.ask`) is **not a security
boundary**. Claude Code's own
documentation says the same. A rule written for `pnpm add` does not match
`npx pnpm add` or `sh -c 'pnpm add'`.

Findings are evidence anchored to turns, not verdicts. Treat them as a reason to
look.
