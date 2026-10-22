---
title: What leaves your machine
description: Nothing, until you opt in — and exactly what happens when you do.
---

Short version: **nothing leaves, until you turn the judge on.** This page is the
long version, because if you are evaluating this on a work machine you deserve
specifics rather than reassurance.

## By default

| | |
|---|---|
| **reads** | `~/.claude/projects/**`, in place |
| **writes** | `~/.local/share/agentsensei` — its own store |
| **writes, with consent** | `~/.claude/settings.json`, only via `agentsensei install`, which prints the exact change and does nothing without `--apply` |
| **sends** | nothing |

`agentsensei scan` prints `copied nothing` because it is literally true. Your
transcripts are read with a ranged file read and the derived form is what gets
stored — a structural skeleton, with text already redacted.

## When you enable the judge

Some failures leave no structural trace. An agent saying "all tests pass" when
they did not looks, structurally, exactly like an agent saying "all tests pass"
when they did. Reading the conversation is the only way, and that means a model.

So `agentsensei judge --enable --apply` exists, it is **off by default**, and
enabling it is a deliberate two-step act for the same reason `install` is.

With it on, redacted transcript text is sent to a model through your own Claude
Code CLI. Three things make that defensible:

### Redaction is asserted, not attempted

Before every single call, the packet is checked: if redaction would still change
anything, **the send is aborted**. Not logged, not warned — aborted.

This is not theoretical. Measured across the corpus, **50% of real sessions
carry secret-shaped content** at the fidelity the judge reads — API keys, JWTs,
bearer tokens, URL credentials, assignment-shaped secrets — and tool output is
where it concentrates.

The check is `redact(packet) === packet` rather than "redacting twice gives the
same answer", because the second is weaker and this project got that distinction
wrong once already.

### You see the cost before you spend it

```bash
agentsensei judge          # what one pass would send, having sent nothing
agentsensei judge --status # what is pending, and roughly how long
```

Reported in **tokens, never dollars**. What a token costs depends on your plan
and tier, and on a subscription the figure is notional — so we report the thing
you can verify.

### It is batched, and it stops

Sessions are batched because the per-invocation overhead (26,384 tokens,
measured) dwarfs a single session. A circuit breaker stops the whole thing after
repeated failures. Every entry point exits 0 whatever happens, because a broken
analyzer must never break a session you are in the middle of.

## The kill switch

```bash
AGENTSENSEI_DISABLE=1
```

Checked on the first line of every entry point, including the hooks. Nothing
runs, nothing is read, nothing is sent.

## What we will not do

- **Never write your config without showing you first.** Every write prints a
  diff, requires `--apply`, and takes a backup.
- **Never copy your transcripts.** They are read in place. The store holds
  derived, redacted structure.
- **Never send anything with the judge off.** That is the whole point of it
  being a flag.
