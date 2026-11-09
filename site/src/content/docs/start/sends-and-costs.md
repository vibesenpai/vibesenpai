---
title: What leaves your machine, and what it costs
description: Redacted session text, to the model on your own Claude Code login, after a turn ends, within 2M tokens a day.
---

The model reads are **on from installation**, so what they send and spend is
stated here, near the top.

## The short version

> Your transcripts stay on disk. After a turn ends, **redacted session text
> your provider already logged** goes to the model (Claude Haiku by default)
> through your own Claude Code login. No third party, no service of ours.

| | |
|---|---|
| **read** | `~/.claude/projects/**`, in place: never modified, never copied |
| **written** | the archive (default `~/.local/share/vibesenpai`): derived, redacted data only |
| **sent** | redacted session text, to the model, on your account |
| **when** | in the background, after a turn ends, from the `Stop` hook |
| **how much** | about 60k tokens a session, at most 2M tokens a day |

## What is sent

The judge builds a packet from the session's text. Its shape is fixed in
`src/judge/packet.ts`:

- **Your prompts are sent whole.** The developer's words are never cut.
- **The agent's turns are merged, then capped once** by how long the session
  is: 5,000 characters a turn in a session of up to 8 merged turns, down to 500
  in one of more than 74.
- **The agent's turns include what its tools returned**: files it read, command
  output, search results. They are capped with the rest of the turn, so code
  and output from a session can be part of what is sent.
- A cut keeps the head and the tail, and states how much was left out.

The packet goes to `claude -p` with no tools allowed (`--allowed-tools ''`): the
model reads and answers; it cannot act.

## Redaction is asserted before every call

Redaction happens when the packet is built. Immediately before each call the
packet is checked again, and the send is **aborted** if redaction would still
change anything:

```
  redact(packet) === packet   or the send aborts
```

What `src/redact.ts` removes:

- private keys (PEM blocks)
- provider-prefixed tokens: Anthropic, OpenAI, GitHub, Slack, AWS, Google,
  GitLab, npm, Stripe, Hugging Face and others
- JWTs and bearer tokens
- credentials inside URLs
- values assigned to secret-named variables (`*_TOKEN`, `*_SECRET`,
  `PASSWORD`, `API_KEY` and the like)
- email addresses
- your username in home-directory paths

Commands, paths, commit SHAs and ids are kept: they are the evidence. Nothing is
redacted on entropy alone.

[Where redaction happens in the pipeline →](/vibesenpai/architecture/judge/)

## On whose account

Your own. The judge calls the `claude` CLI you are already signed in to, so it
runs on your plan, or on your API key if Claude Code is set up with one. If
Claude Code is configured for Bedrock or Vertex, the packet goes there.

| | where your data goes |
|---|---|
| **mem0** | your memories go to `mcp.mem0.ai`: **a new party** |
| **vibe-log** | optional cloud sync of sanitised patterns: **a new party** |
| **vibesenpai** | the model you already use, on your own account: **nobody new** |

## When

Only the `Stop` hook spends. When a turn ends, the hook starts a detached
judge pass and exits; the pass never runs inside the turn. Opening
`/vibesenpai:insights` or `/vibesenpai:report` sends nothing.

The first time a session starts after installation, a one-time notice states
these figures and the off switch. Nothing is spent until that session's first
turn ends.

The automatic pass reads:

- the live session again after about 50 new turns
- **up to 200 past sessions once**, newest first; the cutoff is stored, so a
  later pass never reaches further back
- within **2M tokens a day** (local day). When the day's budget is reached, the
  pass stops and continues the next day.

[Phases of a run →](/vibesenpai/architecture/phases/)

## What it costs

```
  per session     about 60k tokens
  per day         at most 2M tokens, about 33 sessions
```

A packet is filled with whole sessions up to 60,000 tokens, and each model call
carries about 26k tokens of invocation overhead of its own, so sessions share a
call.

Each call's tokens and the dollar figure Claude Code reports for it
(`total_cost_usd`) are recorded. `/vibesenpai:judge` shows them. The dollars are
Claude Code's own figure at API prices; on a subscription they are plan usage,
not a bill.

## How to stop it

```
/vibesenpai:judge off
```

Stops the model reads. The free checks keep running, and nothing is sent.
`/vibesenpai:judge on` turns them back on.

```
/plugin disable vibesenpai
```

Stops everything, the hooks included. `VIBESENPAI_DISABLE=1` does the same from
the environment.
