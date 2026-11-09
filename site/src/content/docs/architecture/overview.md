---
title: Overview
description: Several entry paths share one spine; the judge runs in the background, and the store holds derived data, never transcripts.
---

Two things about the shape of this tool that a straight-line diagram would get
wrong.

![The vibesenpai pipeline](../../../diagrams/pipeline.svg)

**It is not one pipeline.** Several paths read transcripts, and they differ in
how bytes get off disk, not in what happens afterwards. `insights` reads the
live session and what the background passes stored. `report` walks many
sessions, for the HTML report and for the pane. The standing pass runs detached
and reads everything. The judge runs detached from the `Stop` hook and reads
text the free checks never see.

**The catalog is a side-branch, not a stage.** `scan` records byte offsets and
hashes so a re-read is cheap, and `doctor` reports on it. Neither `insights`,
`report`, the standing pass nor the judge consults it. Findings from the free
checks are re-derived from the source every time.

## The spine

| | |
|---|---|
| **read** | byte ranges, in place. Never opens a source for writing |
| **parse** | JSONL → events, in **file order**. [Why not the tree →](/vibesenpai/architecture/reading/) |
| **redact** | here, at construction: not before display, not before sending |
| **detect** | structure only. [The compiler enforces it →](/vibesenpai/architecture/two-tiers/) |
| **findings** | identity, dedup, and the count that makes a finding stable |

## What is stored

`store.db` (SQLite, in the archive) holds what cannot be re-derived for free:

- the judge's findings, with the quote each one is anchored to, redacted
- the ledger: how far into each session the judge has read, as a byte offset
- spend: running totals of tokens, and of the dollar figure Claude Code reports
- dismissals, as ids and enums
- fix sightings: when a fix's marker was first seen, and whether its rule was
  seen loaded

It holds **no transcript copies**. What it stores is redacted when it is built.
The free checks' findings are not stored there: they are computed from the
transcript each time, so a stale index cannot produce a stale finding.

## No aggregate is a finding

A session-wide ratio has no turn to point at, and everything this tool says must
point at a turn. Ratios and token counts appear as *context* beside findings,
never as findings.

## Where to go next

- **[Phases of a run](/vibesenpai/architecture/phases/)**: when each part
  fires, what spends, and how a failing job heals
- **[Reading a transcript](/vibesenpai/architecture/reading/)**: the no-copy
  rule, and the tree-walk that would have been a silent bug
- **[The two tiers](/vibesenpai/architecture/two-tiers/)**: the free checks and
  the judge, and why one of them cannot read text
- **[The judge pipeline](/vibesenpai/architecture/judge/)**: windows, the
  lookback gate, and where redaction happens
