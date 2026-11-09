---
title: Design decisions
description: The choices that shaped everything else, each with the cost it carries.
---

Dnn numbers refer to entries in
[`DECISIONS.md`](https://github.com/vibesenpai/vibesenpai/blob/main/DECISIONS.md)
in the repository.

This page lists the decisions that, if reversed, would make vibesenpai a
different tool. Each states why it was made and what it costs. The full record,
including reversed decisions, is in `DECISIONS.md`.

## Never copy a transcript

**Why:** a copy of a file holding a leaked secret is a second exposure, in a
place you never chose.

**Cost:** no history beyond Claude Code's own retention. When it deletes a
session, it is gone here too.
[Reading a transcript](/vibesenpai/architecture/reading/)

## Structure decides; text may only label

**Why:** detectors that read text did not work
([Contribute](/vibesenpai/contribute/#how-do-i-add-a-detector)).

**Cost:** whole kinds of problem are out of reach of the free checks, which is
why the model reads exist.
[The two tiers](/vibesenpai/architecture/two-tiers/)

## Each detector declares its own scope

**Why:** a window is a token budget, the amount a model can read at once. That
is a different question from the span a free check should look at. Running
checks per window split evidence that belonged together.

**Cost:** the runner handles several scopes (`window`, `thread`, `session`), and
each detector must declare the right one.

## Evidence is keyed by `uuid`, never by position

**Why:** a turn's position changes when a rewind or compaction changes which
branch is live. A finding stored as "turns 31, 44" would point at different
turns after the next rewind.

**Cost:** every display resolves uuids back to positions when it renders.

## A finding is identified by its subject

**Why:** keying on the evidence range would make a finding with seven
violations a *different* finding when an eighth appears. Someone who dismissed
it would be asked again.

**Cost:** the count grows inside a stable finding, so merging is more complex
than appending.

## A ratio is never a finding

**Why:** a session-wide ratio has no turn to point at, and every finding points
at a turn.

**Cost:** numbers such as how much context is re-read, or compaction volume, appear only as
context beside a finding.

## The summary appears at session start, in a message to you (D58)

**Why:** the summary is a message shown to you, not the agent, so showing it
does not change the session being measured. Nothing is ever added to what the
agent reads.

**Cost:** one moment to be seen. Nothing is shown mid-session.

## The plugin is the only way in (D64)

**Why:** `/plugin install` declares the hooks and commands from the manifest.
Nothing in vibesenpai writes `~/.claude/settings.json`.

**Cost:** no install path outside the plugin. The CLI is the engine the plugin
runs; it is not typed by hand.

## Dismissing hides; it never deletes (D65)

**Why:** the free checks are recomputed on every pass, so a deleted finding
would come back. A dismissal is stored as ids and fixed values only, and every
view that hides findings says how many.

**Cost:** the judge still reads dismissed findings, or it would report the same
moment again under a new id.

## Cache numbers appear only beside a rebuild (D66)

**Why:** cache totals and hit rates are ordinary. A **rebuild**, where the
cached conversation is thrown away and written again, is not, so it is shown with its
turn, the gap before it, and what was written.

**Cost:** no usage dashboard. A session with no rebuild shows no cache numbers.

## Each finding gets its own fix (D67)

**Why:** a per-dimension line could be pasted into any `CLAUDE.md`. A judged
finding's fix is built from its evidence:

- a forbidden command becomes a `permissions.ask` entry
- a write outside the project becomes a `PreToolUse` guard on that path
- an earlier expectation becomes a rule scoped to the files written in spite
  of it

**Cost:** only some findings carry enough evidence; the rest show their
dimension's fix.

## Releases ship as a zip; installs are counted from downloads (D69)

**Why:** Claude Code gives a plugin author no install count, and vibesenpai
sends no telemetry. GitHub counts downloads of a release zip.

**Cost:** a download is a first install or a manual upgrade, not a unique user.
[Releases and install counts](/vibesenpai/architecture/releases/)

## Three slash commands; the pane is where findings are acted on (D70)

**Why:** separate fix, apply and dismiss commands each duplicated the pane. What
remains: `/vibesenpai:insights`, `/vibesenpai:judge on|off` (the one switch for
spending) and `/vibesenpai:report`. Apply drafts a request into the prompt box;
your Enter is the yes.

**Cost:** a finding's own fix appears after the next history pass, not the
moment it is judged. Until then its dimension's fix shows.

---

Detectors that were built and then removed are in
[the graveyard](/vibesenpai/work/graveyard/).
