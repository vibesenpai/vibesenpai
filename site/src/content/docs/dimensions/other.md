---
title: Other
description: A real problem that none of the four named kinds describes, kept rather than forced into a poor fit.
---

Something went wrong that none of the four named kinds describes. Rather than
force it into the wrong one, or drop it, the finding is kept with a short
description of what it is.

## The dimension

| | |
|---|---|
| In the pane | Other |
| Key | `other` |
| Tier | model read |
| On by default | yes, with the model reads (`/vibesenpai:judge off` turns them off) |
| Confidence | the model's own rating (high, medium or low), stored per finding |

## Description

The model found and anchored a real problem, but could not honestly place it in
any of the four named kinds. Without this kind, such a problem would have no
label and would be lost.

The model is told to use `other` rather than force a poor fit, and to describe
the problem in 3 to 8 words. An `other` finding with no description is dropped.

What it is not:

- **Not a bucket for weak findings.** It passes the same quote check as every
  kind, and the same lookback gate as misread intent and constraint violation.
- **Never a secondary kind.** A finding can be `other` only as its main kind.

## Example conversation

From the public test data of [claude-code-log](https://github.com/daaain/claude-code-log) (MIT).

The developer and the agent had been fixing a script that extracts review
comments from pull requests.

> **Developer**, turn 641 (cited): "It's almost perfect now! I just got another round of comments and the only thing missing is from the main (not inline) comment after a new commit that has the "Outside diff range comments" section…"
>
> **Agent**: investigates and asks how the comment is formatted.
>
> **Developer**, turn 655 (cited): pastes the raw HTML of the comment.
>
> **Agent**: finds the section inside a nested quote block and fixes the parser.

What the finding records:

| | |
|---|---|
| Why | The developer's stated expectation that the 'Outside diff range comments' section be included was not met because the parser dropped content inside the nested quote block, which is a parsing defect rather than a misreading or rule breach. |
| Established | turn 641, the developer's words above |
| Cited turns | 641, 655 |

## How it's detected

A model reads a redacted copy of the session, finds the episode, anchors it to
a quote, and names its kind. The shared steps are on
[The judge pipeline](/vibesenpai/architecture/judge/).

What is specific to this kind:

- **A description is required.** No description, no finding.
- **The lookback gate applies.** The finding must name where the expectation was
  set before the agent acted, as for misread intent and constraint violation.
  Without the gate, findings it would have dropped ended up as `other`.

![How an Other finding is labelled and gated](../../../diagrams/other.svg)

## Applicable fixes

Which fix the pane shows first is explained in
[How a fix is chosen](/vibesenpai/dimensions/#how-a-fix-is-chosen).

### The kind's fix

There is none. `other` is unknown by construction, so there is nothing general
to offer. The HTML report says: "This is the escape hatch: a real problem none
of the four dimensions describes. There is nothing to recommend yet — the point
is to collect these until a pattern is visible."

### The finding's own fix

An `other` finding records where the expectation was set, so it can still have
its own fix. The first one that fits is offered.

**Claude Code asks you before this command runs, in every mode:**
- When: you forbade a command, and the agent ran it.
- Adds: `"Bash(<command> *)"` to `permissions.ask`.
- Lands in: `.claude/settings.local.json`.
- Apply: yes.

**A test that fails when this rule is broken:**
- When: the expectation was already in a loaded instruction file.
- Adds: a request for a test, lint rule or type constraint. The agent shows it to
  you before adding it.
- Lands in: a test or check in this project.
- Apply: yes.

**A rule the agent reads when it opens these files:**
- When: the expectation was set in an earlier prompt, and 1 to 5 project files
  were written.
- Adds: `- Standing instruction from the developer: "<your words>"`, scoped to
  those files.
- Lands in: its own file under `.claude/rules/vibesenpai/`.
- Apply: yes.

**A rule the agent reads in every session of this project:**
- When: the expectation was set in an earlier prompt.
- Adds: `- Standing instruction from the developer: "<your words>"`.
- Lands in: `.claude/rules/vibesenpai.md`.
- Apply: yes.

Your words are used only when they are 240 characters or fewer. When none of
these fits, the pane shows the finding with no fix.
