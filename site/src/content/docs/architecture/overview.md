---
title: Overview
description: Several entry paths share one spine; the judge runs in the background, and the store holds derived data, never transcripts.
---

This page shows how vibesenpai reads your sessions, what it keeps, and what it
never keeps. The pages linked at the end go deeper on each part.

![The vibesenpai pipeline](../../../diagrams/pipeline.svg)

## Who reads the transcripts?

Several paths read Claude Code's transcript files. They differ in what they
read, not in how they process it:

| path | reads |
|---|---|
| `/vibesenpai:insights` | the live session, plus what the background passes stored |
| `/vibesenpai:report` and the pane | many sessions, for the HTML report and the side pane |
| the standing pass | every session; runs in the background and computes the free checks and each finding's fix |
| the judge | conversation text the free checks never see; runs in the background after a turn ends |

There is also a catalog of byte offsets and hashes, which makes re-reading a
file cheap. None of the paths above relies on it: the free checks are
recomputed from the transcript every time.

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

`store.db` is a SQLite file in vibesenpai's own data directory (the archive).
It holds what was derived, never the source:

- findings from both tiers, each with its anchor; a judge finding also keeps
  its redacted quote
- how far into each session the judge has read, as a byte offset
- each session's size and the tokens the judge would need to read it
- spend: total tokens, and the dollar figure Claude Code reports
- dismissals, as ids and fixed values
- when a fix's marker was first seen, and whether its rule was seen loaded

It holds **no copy of any transcript**. The standing pass recomputes the free
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
  the judge, and why a detector cannot read text
- [The judge pipeline](/vibesenpai/architecture/judge/): batches, the lookback
  gate, and where redaction happens
