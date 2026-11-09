---
title: Design decisions
description: The choices that shaped everything else, each with the cost it carries.
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

## The summary arrives at session start, as a `systemMessage` (D58)

**Because** a `systemMessage` reaches you and not the model, so showing it does
not change the session being measured. The statusline it replaced is gone.
`additionalContext` is never used: it reaches the model too.

**Cost:** one moment to be seen, at the start of a session. Nothing is shown
mid-session.

[D58 in DECISIONS.md →](https://github.com/vibesenpai/vibesenpai/blob/main/DECISIONS.md)

## The plugin is the only front door (D64)

**Because** `/plugin install` declares the hooks and commands from the
manifest. The installer that merged entries into `~/.claude/settings.json` was
deleted, and with it the project's only code that wrote your config.

**Cost:** no install path outside the plugin. The CLI remains as the engine the
plugin runs; it is not typed by hand.

[D64 in DECISIONS.md →](https://github.com/vibesenpai/vibesenpai/blob/main/DECISIONS.md)

## Dismissing hides; it never deletes (D65)

**Because** the free checks' findings are re-derived from transcripts on every
pass, so a deleted one would come back at the next session start. A dismissal is
recorded as ids and enums only, and every surface that shrinks says how many
are dismissed.

**Cost:** the judge still reads dismissed findings, or it would report the same
episode again under a new id.

[D65 in DECISIONS.md →](https://github.com/vibesenpai/vibesenpai/blob/main/DECISIONS.md)

## Cache numbers appear only beside something abnormal (D66)

**Because** plain cache totals are ordinary, and the hit rate is mechanical. A
**rebuild**, where the prefix is thrown away and written again, is abnormal by
kind, so it is shown with its turn, the gap and what was written.

**Cost:** no usage dashboard. A session with no rebuild shows no cache numbers.

[D66 in DECISIONS.md →](https://github.com/vibesenpai/vibesenpai/blob/main/DECISIONS.md)

## A fix for each finding (D67)

**Because** a per-dimension line could be pasted into any `CLAUDE.md`. A judged
finding's fix is built from its own evidence: a forbidden command becomes a
`permissions.ask` entry, a write outside the project a `PreToolUse` guard on
that path, an earlier expectation a rule scoped to the files written in spite of
it. The dimension's fix is the fallback.

**Cost:** only some findings carry enough evidence for their own fix; the rest
show their dimension's.

[D67 in DECISIONS.md →](https://github.com/vibesenpai/vibesenpai/blob/main/DECISIONS.md)

## Releases ship as a zip; installs are counted from downloads (D69)

**Because** Claude Code gives a plugin author no install count, and this
project sends no telemetry. A zip on a tagged GitHub release, pinned by
`sha256`, is the one first-party trace: GitHub counts its downloads.

**Cost:** a download is a first install or a manual upgrade, not a unique user.

[Releases and install counts →](/vibesenpai/architecture/releases/) ·
[D69 in DECISIONS.md →](https://github.com/vibesenpai/vibesenpai/blob/main/DECISIONS.md)

## Three slash commands; the pane is where findings are acted on (D70)

**Because** `fix`, `apply` and `dismiss` each duplicated the pane. What remains:
`/vibesenpai:insights`, `/vibesenpai:judge on|off` (the one switch for
spending) and `/vibesenpai:report`. Apply drafts a request into the prompt box;
your Enter is the yes.

**Cost:** a finding's own fix appears after the next standing pass, not the
moment it is judged; until then its dimension's fix shows.

[D70 in DECISIONS.md →](https://github.com/vibesenpai/vibesenpai/blob/main/DECISIONS.md)

---

The full record, including the ones that were reversed, is in
[`DECISIONS.md`](https://github.com/vibesenpai/vibesenpai/blob/main/DECISIONS.md).
The ones that were **built and then deleted** are in
[the graveyard](/vibesenpai/work/graveyard/), which is the more interesting
half.
