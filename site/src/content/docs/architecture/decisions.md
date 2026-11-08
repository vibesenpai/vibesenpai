---
title: Design decisions
description: Six choices that shaped everything else, each with the cost it carries.
---

Not a changelog — the handful of decisions that, if reversed, would make this a
different tool. Each one cost something, and the cost is stated.

## Never copy a transcript

**Because** a copy of a file containing a leaked token is a second exposure, in
a location we chose, that the user never asked for.

**Cost:** no history beyond the harness's own retention. When Claude Code
deletes a session, it is gone for us too. There is no archive to fall back on,
and we decided not to build one rather than build one with an opt-out.

## Structure decides; text may only label

**Because** three detectors built on text produced 5 true positives against ~25
false positives across 1,139 sessions.

**Cost:** whole categories of real problem are unreachable by rules, which is
why there is a second tier at all.
[The compiler enforces this →](/vibesenpai/architecture/two-tiers/)

## Scope belongs to the detector, not the pipeline

**Because** a window exists for a *token budget* — what a model can afford to
read — and that is a different question from the span a *rule* should evaluate.
Conflating them was a precision bug: of 363 genuinely verified edits, **293
(81%) were verified by a command in a later window.** A per-window rule would
have called every one of them unverified.

**Cost:** the runner has to dispatch four scopes, and one of them (`project`)
is declared but deliberately throws rather than silently evaluating the wrong
span.

## Evidence is keyed by `uuid`, never by position

**Because** `seq` is a position on the active path, and the path changes when a
rewind or compaction alters which branch is live. A finding stored as "turns
31, 44" silently points at different turns after the next rewind.

**Cost:** every display has to resolve uuids back to positions at render time.

## A finding is identified by its subject

**Because** keying on the evidence range fragments findings as evidence
accumulates. A finding with seven violations becomes a *different* finding when
an eighth appears — so someone who dismissed it gets asked again about
something they already judged.

**Cost:** the count has to grow inside a stable finding, which makes merging
more complex than appending.

## An aggregate is not a finding

**Because** a session-wide ratio has no turn to anchor to, and everything this
tool says must point at a turn.

**Cost:** some genuinely interesting numbers — re-ingest ratios, compaction
volume — can only appear as *context* beside a finding, never as the finding.
That is why `now` shows them under `SESSION COST` rather than flagging them.

---

The full record, including the ones that were reversed, is in `DECISIONS.md`.
The ones that were **built and then deleted** are in
[the graveyard](/vibesenpai/work/graveyard/), which is the more interesting
half.
