---
title: /vibesenpai:judge
description: Turns the model reads on or off, and shows how far they have got and what they have spent.
---

Turns the model reads on or off, and shows how far they have got and what they have spent.
It is the one switch for spending. The judge is what does the model reads.

```
/vibesenpai:judge on
/vibesenpai:judge off
/vibesenpai:judge
```

The model reads are **on by default**: installing the plugin turns them on. The free checks
run whether the model reads are on or off.

## Arguments

| | |
|---|---|
| `off` | stops the model reads. Prints `judge disabled. nothing further will be sent.` The free checks keep running |
| `on` | turns the model reads back on. It prints what one pass would send (sessions and tokens of transcript, the fixed overhead per call, the batch ceiling and the daily limits), then `judge enabled. it runs detached, after your turn ends.` It also lifts a hold after repeated failures ([below](#when-it-fails)) |
| *(nothing)* | shows the status |

## Status

With no argument it shows what has been read, what is left, and today's use. From a demo run
over the public test data of
[claude-code-log](https://github.com/daaain/claude-code-log) (MIT), before any model call:

```
judge · enabled · model haiku

  read       17 session(s) · 0 finding(s)
  pending    84 never read

  read in the background from when a turn ends, within the daily limit.

  today      0 of 2.0M tokens
```

17 of the 101 transcripts are empty, so they count as read before any call is made.

After calls have been made, it adds what they cost. From the same demo run, once every session
had been read:

```
  spent      11 call(s) · 576k in · 61k out · $0.08
  dollars are Claude Code's own figure at API prices; on a subscription it is plan usage, not a bill.
```

When the model reads are off and sessions are still waiting, it prints
`disabled — nothing will be read or sent.` in place of the line about reading in the background.
The free checks keep running.

## When it runs

Only when a turn ends. The `Stop` hook starts a model read in the background, so your session
never waits on it. No slash command spends: [`/vibesenpai:insights`](/vibesenpai/commands/insights/)
and the pane only show results.

A live session is read again after about 50 new turns. Several sessions share one call.

## Limits

| limit | default | what happens |
|---|---|---|
| tokens a day | 2,000,000, in and out, per local day | reading stops until tomorrow |
| catch-up | 200 past sessions | the first time, it reads up to 200 past sessions, newest first. After that, only new ones |

Past sessions older than the catch-up are not read automatically, to keep the first-day spend
bounded. The Health tab counts them on its **Older** row.

Both limits are in `judge-settings.json` ([Reference](/vibesenpai/reference/#model-read-settings)).

## When it fails

- **A failure that cost nothing** (a pass that could not start, crashed or timed out) is
  retried, with a longer wait each time.
- **A failure after a model call** counts separately. After 3 in a row with no success between,
  the model reads stop until you run `/vibesenpai:judge on`.

While a job is failing, each session start says so in one line, and so does the pane's Health tab.

## What it uses

- **Model:** Claude Haiku by default.
- **Account:** your own Claude Code account (plan or API key), through the `claude` CLI as
  `claude -p`. There is no API key or service of ours.
- **What it sends:** a redacted part of each session. If redaction would still change anything
  just before a call, the call is not made.

[What leaves your machine](/vibesenpai/start/sends-and-costs/) has the details.
[The judge pipeline](/vibesenpai/architecture/judge/) explains how the reads work.

## Turning everything off

| | |
|---|---|
| `/plugin disable vibesenpai` | stops everything, the free checks and hooks included |
| `VIBESENPAI_DISABLE=1` | the same, from the environment Claude Code runs in |
