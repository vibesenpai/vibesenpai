---
title: The graveyard
description: Detectors that were built or proposed, measured, and removed, with the number that removed each one.
---

This page lists detectors that were measured and removed, and the number that
removed each. It also lists mistakes in how the judge was measured.

The measurements use 1,139 real Claude Code sessions from the public
[SWE-chat](https://huggingface.co/datasets/SALT-NLP/SWE-chat) dataset. The full
record is in
[`GRAVEYARD.md`](https://github.com/vibesenpai/vibesenpai/blob/main/GRAVEYARD.md).

## What is in the graveyard?

Three shipped detectors were removed. Ten more candidates and several probes
were measured and never shipped. These five show the pattern.

### `stale_read`: every case had an innocent cause

**Idea:** the agent reads a file, something else changes it, and the agent acts
on the old copy.

**Result:** it matched 27.7% of sessions. All 2,078 candidates followed the
agent's own earlier edit to that file. No case was left where something
external had changed the file.

A detector whose every match has an innocent cause has nothing to detect.

### `permission_denied`: the denials were people deciding

**Idea:** a denied tool call is wasted work.

**Result:** 18.1% of sessions had one. The denials were `ExitPlanMode` and
`AskUserQuestion`: a person rejecting a plan or answering a question. That is
plan mode working, not failing.

### `inaccurate_self_report` as a rule: 0 true, 5 false

**Idea:** a success claim near a failed tool result is a false report.

**Result:** **0 true positives and 5 false positives.** Each of the five was an
accurate report of partial progress.

The dimension itself is real. It works as a
[judge](/vibesenpai/architecture/judge/) dimension, because the judge reads what
was said. Same dimension, different tier, opposite result.

### `file_churn`: frequent, and not shown to be waste

**Idea:** a file edited many times in one session is rework.

**Result:** 48% of sessions edit some file five or more times, and 23% ten or
more. A narrower test, a file with more than five versions in Claude Code's file
history, matches 11%
([docs/findings-frequency.md](https://github.com/vibesenpai/vibesenpai/blob/main/docs/findings-frequency.md)).

Detection was never the problem. No one could show that churn is waste:
editing a file several times is how most work gets done.

### `reading_spiral`: the documented reason was wrong

**Idea:** reading the same file three or more times with no edit between is a
loop. It matched 51% of sessions and was never built.

| check | result |
|---|---|
| the documented confound, subagents reading in parallel | **4 of 2,182** |
| were the repeated reads the same call? | **15 the same, 2,167 different** |

The documented reason was wrong, and the measured one removed it anyway.
Different reads of one file are an agent studying it: reading in pages, or
searching for different things.

## What went wrong in measuring the judge?

These are mistakes in method, not in detectors. Each one comes from the judge's
evaluation on 246 labelled sessions from a
[research dataset](https://arxiv.org/abs/2605.29442).

| what was reported | what was true |
|---|---|
| a rubric change made results worse | measured on 60 of 246 sessions, against a baseline edited mid-run. On all 246 it adds **+11 points** of session-level agreement |
| three runs of "identical code" scored 52%, 66% and 67%, so the judge is unstable | the prompt file was rewritten during the experiment. Runs 2 and 3 used the same code: **66% and 67%** |
| a 60-session sample was enough | an early cost choice, never revisited. Scoring now reads the whole labelled set |

All three have one cause: the thing being measured changed during the
measurement.

## Why is this public?

- It stops the same ideas being rebuilt: each entry has the number that
  removed it.
- It shows that the dimensions that shipped were tested against alternatives.
- A tool that shows an agent's mistakes with evidence shows its own the same
  way.
