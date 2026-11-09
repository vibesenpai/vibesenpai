---
title: The graveyard
description: Detectors that were built or proposed, measured, and removed, and why.
---

This page lists detectors that were measured on real sessions and removed, and
why. The figures are on [How it was measured](/vibesenpai/architecture/measurements/#the-graveyard);
the full record is in
[`GRAVEYARD.md`](https://github.com/vibesenpai/vibesenpai/blob/main/GRAVEYARD.md).

## What is in the graveyard?

Three shipped detectors were removed. Ten more candidates, and several quick
one-off measurements, were run and never shipped. These five show the pattern.

### `stale_read`: every case had an innocent cause

**Idea:** the agent reads a file, something else changes it, and the agent acts
on the old copy.

**Result:** every match followed the agent's own earlier edit to that file. No
case was left where something external had changed the file.

### `permission_denied`: the denials were people deciding

**Idea:** a denied tool call is wasted work.

**Result:** the denials were `ExitPlanMode` and `AskUserQuestion`: a person
rejecting a plan or answering a question. That is plan mode working, not
failing.

### `inaccurate_self_report` as a free check: none were right

**Idea:** a success claim near a failed tool result is a false report.

**Result:** every match was an accurate report of partial progress.

The dimension itself is real. It is now a model read
([Inaccurate self report](/vibesenpai/dimensions/inaccurate-self-report/)),
because a model reads what was said.

### `file_churn`: common, and not shown to be waste

**Idea:** a file edited many times in one session is rework.

**Result:** about half of all sessions do it. Detection was never the problem.
No one could show that churn is waste: editing a file several times is how most
work gets done.

### `reading_spiral`: the first explanation was wrong

**Idea:** reading the same file three or more times with no edit between is a
loop. It matched about half of all sessions and was never built.

**Result:** the reason first written down, subagents reading in parallel,
explained almost none of the matches. Nearly all repeated reads were different
calls: the agent was studying the file, reading it in pages or searching it for
different things.

## Why is this public?

- It stops the same ideas being rebuilt: each entry says what removed it.
- It shows that the dimensions that shipped were tested against alternatives.
