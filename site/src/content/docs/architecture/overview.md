---
title: Overview
description: Every path reads transcripts the same way; only the model reads spend tokens.
---

This page shows how vibesenpai reads your sessions, what it keeps, and what it
never keeps. The pages linked at the end go deeper on each part.

![The vibesenpai pipeline](../../../diagrams/pipeline.svg)

## Who reads the transcripts?

Several paths read Claude Code's transcript files. They differ in what they
read, not in how they process it:

| path | reads |
|---|---|
| `/vibesenpai:insights`, as text | the live session, plus what the history pass stored |
| the pane | many sessions, plus what the history pass and the model reads stored |
| `/vibesenpai:report` | many sessions, for the HTML report |
| the history pass | every session; runs in the background and computes the free checks and each finding's fix |
| the model reads | conversation text the free checks never see; run in the background after a turn ends. The judge is what does them |

There is also `index.json`, an optional index of byte offsets and hashes. None
of the paths above relies on it: the free checks are recomputed from the
transcript every time.

## What happens to each transcript?

Every path runs the same steps:

| step | what it does |
|---|---|
| **read** | reads byte ranges in place; never opens the file for writing |
| **parse** | turns JSONL lines into events, in **file order** ([why not the tree](/vibesenpai/architecture/reading/)) |
| **redact** | removes secrets as events are built, not later |
| **detect** | reads structure only ([the compiler enforces it](/vibesenpai/architecture/two-tiers/)) |
| **findings** | gives each finding a stable identity and counts repeats |

## What is stored?

`store.db` is a SQLite file in vibesenpai's own data directory (the `archive`
setting). It holds what was derived, never the source:

- findings from both tiers, each with the turns it points at; a model finding
  also keeps its redacted quote
- how far into each session the judge has read, as a byte offset
- each session's size and the tokens the judge would need to read it
- spend: total tokens, and the dollar figure Claude Code reports
- your answers (hidden, wrong, not the agent's fault), stored by finding id
- when a fix's marker was first seen, and whether its rule was seen loaded

It holds **no copy of any transcript**. The history pass recomputes the free
checks from the transcripts each time it runs, rather than trusting what it
stored before.

## Why is a ratio never a finding?

A session-wide ratio has no turn to point at, and every finding points at a
turn. Ratios and token counts appear only as context beside a finding.

## Where to go next

- [Phases of a run](/vibesenpai/architecture/phases/): when each part runs,
  what spends tokens, and how a failed job recovers
- [Reading a transcript](/vibesenpai/architecture/reading/): why nothing is
  copied, and why events follow file order
- [The two tiers](/vibesenpai/architecture/two-tiers/): the free checks and
  the model reads, and why a detector cannot read text
- [The judge pipeline](/vibesenpai/architecture/judge/): batches, the lookback
  gate, and where redaction happens
