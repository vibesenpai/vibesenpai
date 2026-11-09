---
title: Misread intent
description: The request left room, and the agent filled it with a reading the developer did not mean.
---

## The dimension

| | |
|---|---|
| In the pane | Misread intent |
| Key | `misread_intent` |
| Tier | model read |
| On by default | yes, with the model reads (`/vibesenpai:judge off` turns them off) |
| Confidence | the model's own rating (high, medium or low), stored per finding |

## Description

The developer's request left interpretive room, and the agent filled it the wrong
way. The misalignment is in the agent's understanding of the developer, not in a
rule it broke. A visible correction from the developer is not required for the
label (GRAVEYARD.md records that requirement being dropped).

What it is not:

- **Not [constraint violation](/vibesenpai/dimensions/constraint-violation/).**
  If the developer stated the thing literally, ignoring it is a violation. A
  misread needs room for a second reading.
- **Not [overreach](/vibesenpai/dimensions/overreach/).** Doing extra work on a
  correct reading is overreach. Doing different work on a wrong reading is a
  misread.
- **Not a change of mind.** A new preference brought to work in progress is a
  suggestion, and the lookback gate drops it.

There is no per-dimension frequency from a source this site cites. Across all
model-read kinds, agreement with published labels is in
[How accurate it is](/vibesenpai/work/measuring/).

## Example conversation

From the public test data of [claude-code-log](https://github.com/daaain/claude-code-log) (MIT).

> **Developer**, turn 0: "…refactoring the timeline filtering so that we hide the group instead of all items that belong to a group as that would also collapse the row in the timeline."
>
> **Agent**: reads the styles, then starts a MultiEdit that hides the group by
> working through its items. The developer stops the tool call.
>
> **Developer**, turn 15 (cited): "You can set group.visible using the vis library which is less work"

What the finding records:

| | |
|---|---|
| Why | The developer asked to hide the vis-group rather than all items in it, but the agent started with a manual per-item approach, and the developer redirected it to the library's group.visible property. |
| Established | turn 0, "refactoring the timeline filtering so that we hide the group instead of all items that belong to a group" |
| Cited turn | 15 |

The same session has a second misread five turns later: the agent planned to loop
over all items again, and the developer answered "I don't think we need to loop
through all items, the group names should match the filters?"

The pane shows the developer's quote as the row's headline, then the
conversation around the cited turn and **Why**. Where the expectation was
established is stored with the finding; the pane does not display it today.

## How it's detected

The session is built into a packet and redacted. The extract stage finds
episodes without being shown any categories, each anchored by a quote that must
be found in the packet. The label stage then names the kind. The shared pipeline
is on [The judge pipeline](/vibesenpai/architecture/judge/).

What is specific to this kind is the **lookback gate**. The expectation must
have existed before the agent acted: an earlier prompt, a loaded instruction, or
the developer's own words saying it was settled before ("as we did in the
report"). The code checks the quoted source against what was sent. With no
source, or a quote that cannot be found, the record is dropped as a suggestion.

![How a misread intent is labelled and gated](../../../diagrams/misread-intent.svg)

## Applicable fixes

A finding's own fix is shown first, under the finding. The dimension's fix is the
fallback, under the Misread intent heading.

**The finding's own fix**, built from its evidence. The first rung the evidence
supports is offered:

| Kind, in the pane's words | When | What it adds | Where | Apply |
|---|---|---|---|---|
| Claude Code asks you before this command runs, in every mode: | the developer forbade a command's verb, and the agent ran it | `"Bash(<command> *)"` in `permissions.ask` | `.claude/settings.local.json` | yes |
| A test that fails when this rule is broken: | the expectation was already a loaded instruction | a request for a test, lint rule or type constraint; the agent shows it before adding it | a test or check in this project | yes |
| A rule the agent reads when it opens these files: | the expectation was set in an earlier prompt, and 1 to 5 project files were written | `- Standing instruction from the developer: "<their words>"` with a `paths:` list | `.claude/rules/vibesenpai/<fix id>.md` | yes |
| A rule the agent reads in every session of this project: | the expectation was set in an earlier prompt | `- Standing instruction from the developer: "<their words>"` | `.claude/rules/vibesenpai.md` | yes |

The words are used only when they are 240 characters or fewer; a longer prompt is
a pasted paragraph, not a standing instruction.

**A shared fix, when a question got an edit.** When the developer asked a question
(their prompt ends in `?`) and the agent wrote files in reply, in two or more
sessions, the pane offers:

> A helper that answers questions and cannot edit:

It creates `.claude/agents/ask.md`, a subagent limited to `Read, Grep, Glob`
that answers from the code and docs and describes a change rather than making
it. The pane offers Apply.

**The dimension's fix**, shown when the finding has none of its own:

> A rule the agent reads in every session of this project:
>
> Before acting on anything ambiguous, state the reading you are acting on in one line and wait.

It is added to `.claude/rules/vibesenpai.md`, with one pointer line in
`CLAUDE.md`, and the pane offers Apply.

**Printed in the HTML report only, with no Apply** (`/vibesenpai:report`):

- Plan mode, so the reading is agreed before work starts: shift+tab to cycle into
  plan mode, or `claude --permission-mode plan`.
- The same instruction as a prompt for one session: "For the rest of this
  session: before acting on anything ambiguous, state the reading you are acting
  on in one line and wait."
