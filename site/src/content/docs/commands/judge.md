---
title: /vibesenpai:judge
description: Shows what the model reads would send, turns them on after your yes or off, and shows how far they have got.
---

Shows what the model reads would send, turns them on after your yes or off, and shows how far
they have got and what they have spent. It is the one switch for spending. The judge is what
does the model reads.

```
/vibesenpai:judge on
/vibesenpai:judge yes
/vibesenpai:judge off
/vibesenpai:judge
```

The model reads are **off until you say yes**, after seeing what they would send. The free
checks run either way. The pane's **Turn on…** (or **See what would be sent**) and **Turn on** do the
same as `on` and `yes`.

## Arguments

| | |
|---|---|
| `on` | turns nothing on. It builds what the first model read would send, sends it nowhere, and summarises it: where it goes, how many sessions and tokens, what is removed and what is not, how long a yes lasts and what it costs. The full text is in the pane |
| `yes` | turns the model reads on. Refused unless `on` or the pane showed the preview in the last hour. Prints `Model reads are on.` and how long that lasts: until `/vibesenpai:judge off`. It also lifts a hold after repeated failures ([below](#when-it-fails)) |
| `off` | stops the model reads and forgets the yes; turning them on again shows a new preview. The free checks keep running |
| *(nothing)* | shows the status |

## Status

With no argument it shows what has been read, what is left, and today's use. From a demo run
over the public test data of
[claude-code-log](https://github.com/daaain/claude-code-log) (MIT), before any model call:

```
judge: model reads on, model haiku

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

Only after your yes, and then only when a turn ends. The `Stop` hook starts a model read in the background, so your session
never waits on it. No slash command spends: [`/vibesenpai:insights`](/vibesenpai/commands/insights/)
and the pane only show results.

A live session is read again after about 50 new turns. Several sessions share one call.

## Limits

| limit | default | what happens |
|---|---|---|
| tokens a day | 2,000,000, in and out, per local day | reading stops until tomorrow |
| catch-up | 200 past sessions | the first time, it reads up to 200 past sessions, newest first. After that, only new ones |

Past sessions older than the catch-up are not read automatically, to keep the first-day spend
bounded. The Status tab counts them on its **Older** row.

Both limits are in `judge-settings.json` ([Reference](/vibesenpai/reference/#model-read-settings)).

## When it fails

- **A failure that cost nothing** (a pass that could not start, crashed or timed out) is
  retried, with a longer wait each time.
- **A failure after a model call** counts separately. After 3 in a row with no success between,
  the model reads stop until you run `/vibesenpai:judge on`, then `/vibesenpai:judge yes`.

While a job is failing, each session start says so in one line, and so does the pane's Status tab.

## What it uses

- **Model:** Claude Haiku by default.
- **Account:** your own Claude Code account (plan or API key), through the `claude` CLI as
  `claude -p`. There is no API key or service of ours.
- **What it sends:** a redacted part of each session. If redaction would still change anything
  just before a call, the call is not made.

[How your data is used](/vibesenpai/start/sends-and-costs/) has the details.
[The judge pipeline](/vibesenpai/architecture/judge/) explains how the reads work.

## Turning everything off

| | |
|---|---|
| `/plugin disable vibesenpai` | stops everything, the free checks and hooks included |
| `VIBESENPAI_DISABLE=1` | the same, from the environment Claude Code runs in |
