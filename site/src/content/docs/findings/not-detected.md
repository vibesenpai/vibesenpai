---
title: What we do not detect
description: Things that were tried, or considered and refused, and why.
---

An incomplete tool that says what it cannot do is more useful than one that
implies it covers everything.

## Tried and deleted

Ten detectors were built, measured against real sessions, and removed.
[The graveyard has the numbers](/vibesenpai/work/graveyard/) — including
`stale_read`, where 100% of candidates turned out to be the agent's own prior
edit, and `permission_denied`, where only 6 of 398 denials were ever re-issued.

## Refused on principle

**Anything needing your repository.** The judge reads the conversation and the
tool calls inside it, not your code or your diffs. So "it misdiagnosed the
bug" and "the implementation was wrong" are outside what it can honestly
assert — three of the research taxonomy's seven symptom categories are
deliberately unimplemented for exactly this reason.

**Anything that reads as a judgement of you.** No prompting score, no
communication grade. Unfalsifiable, and it makes people defensive rather than
curious.

**Frequency without consequence.** `file_churn` fires on 48% of sessions and
nobody could establish that churn is waste. Iterating is how work gets done. A
finding that common which cannot say whether the thing it found was bad is a
number pretending to be an insight.

## Not yet

A gold evaluation tier. Everything published is agreement with model-generated
labels — [silver, not gold](/vibesenpai/work/measuring/) — and there is no
precision figure for this tool until someone hand-labels a real set.

More harnesses. The parser layer is a registry; one parser exists.
