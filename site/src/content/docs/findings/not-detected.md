---
title: What we do not detect
description: What was tried and removed, what is out of scope by design, and what is not built yet.
---

This page lists what vibesenpai does not report, and why: some ideas were
measured and removed, some are out of scope, and some are not built yet.

## Tried and removed

Detectors that were built or proposed, measured against 1,139 public sessions,
and removed are in [the graveyard](/vibesenpai/work/graveyard/), each with the
number that removed it. Two examples:

- A "stale read" check: every match followed the agent's own earlier edit.
- A "denied tool call" check: the denials were people rejecting a plan or
  answering a question, which is plan mode working.

## Out of scope by design

| not reported | why |
|---|---|
| anything that needs your repository | the judge reads the conversation and tool calls, not your code or diffs. Three of the research taxonomy's seven symptom categories need the code, so they are not implemented |
| a score or grade of you | it cannot be checked against a turn |
| a pattern that is common but not shown to be waste | for example, 48% of sessions edit some file five or more times ([GRAVEYARD.md](https://github.com/vibesenpai/vibesenpai/blob/main/GRAVEYARD.md)). Editing a file several times is how most work gets done |

## Not built yet

- **A gold accuracy figure.** Published accuracy is agreement with
  model-generated labels (silver). There is no precision figure until a real
  set is hand-labelled.
- **Other harnesses.** The parser layer is a registry; it holds one parser,
  for Claude Code.
