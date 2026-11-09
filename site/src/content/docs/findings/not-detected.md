---
title: What we do not detect
description: What was tried and removed, and what is out of scope by design.
---

This page lists what vibesenpai does not report, and why: some ideas were
measured and removed, and some are out of scope.

## Tried and removed

Detectors that were built or proposed, measured on real sessions, and removed
are in [the graveyard](/vibesenpai/work/graveyard/), each with the reason. Two
examples:

- A "stale read" check: every match followed the agent's own earlier edit.
- A "denied tool call" check: the denials were people rejecting a plan or
  answering a question, which is plan mode working.

## Out of scope by design

| not reported | why |
|---|---|
| code the agent never looked at | it never opens your repository; it sees only what the agent's tools returned in the session (files it read, command output). Three of the research taxonomy's seven categories are not covered ([Limits](/vibesenpai/work/limits/#can-it-see-my-code)) |
| a score or grade of you | it cannot be checked against a turn |
| a pattern that is common but not shown to be waste | for example, editing one file many times. That is how most work gets done ([the graveyard](/vibesenpai/work/graveyard/#file_churn-common-and-not-shown-to-be-waste)) |
| sessions from other harnesses | Claude Code only |
