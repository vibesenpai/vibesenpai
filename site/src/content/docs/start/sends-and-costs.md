---
title: What it sends, and what it costs
description: A redacted subset of what your provider already has, on your own account, when you ask — and roughly 58k tokens a session.
---

This page is near the top because the judge is **on from installation**. You
should not have to go looking for what that means.

## The short version

> Your transcripts stay on disk. When you ask for a finding, a **redacted
> subset of what your provider already has** — they logged that session — goes
> to the model on **your** account. No third party, no service of ours, nothing
> you were not already paying for.

The claim this replaces was "nothing leaves your machine". That was true of an
earlier design, where the plan was a local model, and it stopped being true
when the judge started running through your own `claude` CLI. It is said this
way now because the honest version is also the stronger one.

## No new trust relationship

That is the actual differentiator, and it is worth being precise about:

| | where your data goes |
|---|---|
| **mem0** | your memories go to `mcp.mem0.ai` — **a new party** |
| **vibe-log** | optional cloud sync of sanitised patterns — **a new party** |
| **agentsensei** | the model you already use, on your own account — **nobody new** |

And strictly *less* than that provider already holds: what we send is redacted
first, and it is a subset of a session they logged in full.

Note "your provider", not "Anthropic". The judge shells out to your own
`claude` CLI, so if you are configured against Bedrock or Vertex, the excerpt
goes there instead.

## What leaves, exactly

| | |
|---|---|
| **read** | `~/.claude/projects/**`, in place — never modified, never copied |
| **written** | `~/.local/share/agentsensei`, mode 0600 |
| **sent** | redacted session text, to your own model, **when you run a command** |
| **sent unprompted** | nothing. The `Stop` hook does not spawn a judge pass |

That last row is the one that makes the rest defensible.
[Phases of a run](/agentsensei/architecture/phases/) has the detail, and it is
asserted by a test rather than promised.

## Redaction is asserted, not attempted

Immediately before every call the packet is checked, and the send is
**aborted** if redaction would still change anything. Not a warning — a warning
in a detached process is a thing nobody reads.

This is not theoretical. Measured across the corpus, **50% of real sessions
carry secret-shaped content** at the fidelity the judge reads: API keys, JWTs,
bearer tokens, URL credentials. Tool output is where it concentrates.

[The four places redaction happens →](/agentsensei/architecture/judge/)

## What it costs

```
  one session        ~58,000 input + ~4,000 output tokens
  wall clock         about a minute, in the background
  your whole history  judge --backlog, which prints the cost first
```

Reported in **tokens, never dollars**. What a token costs depends on your plan
and tier, and on a subscription the dollar figure is notional — so you get the
number you can verify.

Claude Code attributes recent usage to plugins in `/usage`, so you can see what
this spent without taking our word for it.

For scale: Anthropic says Claude Code's own background work is *"typically
under $0.04 per session"* and does not ask first. `/insights`, which is
first-party and does something similar to this, spends your tokens on exactly
the same terms — when invoked, with no separate opt-in.

## Turning it off

```
/plugin disable agentsensei
```

Harness-native, stops everything including the hooks. `AGENTSENSEI_DISABLE=1`
does the same from the environment.

There is deliberately **no "keep the rules, stop the model" switch.** Without
the judge this is a one-detector tool — `edit_retry` found 4 occurrences across
18 sessions where the judge found 19 — so all-or-nothing is the honest offer
rather than a degraded mode we pretend is useful.
