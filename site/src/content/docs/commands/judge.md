---
title: /vibesenpai:judge
description: Turns the model reads on or off, and shows how far they have got and what they have spent.
---

```
/vibesenpai:judge on
/vibesenpai:judge off
/vibesenpai:judge
```

The one switch for spending. The model reads are **on by default**: installing the plugin is
the decision to run them. The free checks keep running whether the model reads are on or off.

## Arguments

| | |
|---|---|
| `off` | stops the model reads. Prints `judge disabled. nothing further will be sent.` |
| `on` | turns them back on and prints `judge enabled. it runs detached, after your turn ends.`, after a summary of what one pass would send. It also releases a hold after repeated failures (below) |
| *(none, or anything else)* | shows the status |

## Status

With no argument it shows what has been read, what is left, and today's spend. From the demo
data, before any model read:

```
judge · enabled · model haiku

  read       17 session(s) · 0 finding(s)
  pending    84 never read

  read in the background from when a turn ends, within the daily limit.

  today      0 of 2.0M tokens
```

Once calls have been made it adds what they cost, here from the demo run:

```
  spent      11 call(s) · 576k in · 61k out · $0.08
  dollars are Claude Code's own figure at API prices; on a subscription it is plan usage, not a bill.
```

When the model reads are off, the pending line is followed by
`disabled — nothing will be read or sent.`

## When it runs

Only the `Stop` hook starts a model read, when a turn ends. No slash command spends:
[`/vibesenpai:insights`](/vibesenpai/commands/insights/) and the pane only show what is
already there. The read runs detached, so the session never waits on it.

It reads each session as it grows, about every 50 turns of new transcript, and batches
sessions so they share a call.

## Limits

The automatic reads stop at two limits:

| limit | default | what happens at it |
|---|---|---|
| tokens a day | 2,000,000 (in and out, per local day) | reading stops until tomorrow. The pane says `Today's limit is reached; it continues tomorrow.` |
| catch-up | 200 past sessions | the first time, it reads up to 200 never-read past sessions, newest first, then only new ones |

Past sessions older than the catch-up are not read automatically. The Health tab counts them
on its **Older** row. Reading them is not available from a slash command yet.

Both limits are stored in `judge-settings.json` ([Reference](/vibesenpai/reference/#model-read-settings)).

## When it fails

A failure that cost nothing (a pass that could not start, crashed or ran past its deadline)
is retried, waiting longer each time, for ever. A failed pass that had made a model call
counts separately: after **3 of them without a success between** the model reads stop, and
stay stopped until you run `/vibesenpai:judge on`. While a job is failing, each session start
says so in one plain line, and so does the pane's Health tab.

## What it uses

- **Model:** Claude Haiku by default (`model` in `judge-settings.json`).
- **How:** your own `claude` CLI, as `claude -p`, on the login or API key Claude Code already
  uses. No API key of ours, no service of ours. No tools are pre-approved for the call.
- **What it sends:** a redacted part of each session. If redaction would still change
  anything just before a call, the call is not made.
- **Cost:** tokens as Claude Code reports them, and dollars as Claude Code's own figure at API
  prices. On a subscription the dollars are plan usage, not a bill.

The full account is on [What it sends, and what it costs](/vibesenpai/start/sends-and-costs/).
How the reads find what they find is under [The judge pipeline](/vibesenpai/architecture/judge/).

## Related

| | |
|---|---|
| `/plugin disable vibesenpai` | stops everything, the free checks and hooks included |
| `VIBESENPAI_DISABLE=1` | the same, from the environment Claude Code runs in |
