---
title: Overreach
description: Substantial work beyond what was asked, which the developer pushed back on. It does not work yet.
---

:::caution[It does not work yet]
Overreach agrees with labelled data on 1 of 38, 1 of 38 and 2 of 38 episodes,
across three pipeline versions and two models (GRAVEYARD.md). That is recorded as
broken, not untuned. It still runs, because retiring a dimension is a product
decision nobody has made. An overreach finding is a pointer to turns worth
reading, not a conclusion. [Limits](/vibesenpai/work/limits/).
:::

## The dimension

| | |
|---|---|
| In the pane | Overreach |
| Key | `overreach` |
| Tier | model read |
| On by default | yes, with the model reads (`/vibesenpai:judge off` turns them off) |
| Confidence | the model's own rating is stored per finding; measured agreement is 2 of 38 at best |

## Description

The agent did substantial work beyond what was asked, and the developer pushed
back on it. The misalignment is in the agent acting unprompted. The push-back
requirement is deliberately kept for this kind, where it was dropped for the
others (GRAVEYARD.md).

It does not work yet: 2 of 38 at best against labelled data (GRAVEYARD.md).

What it is not:

- **Not [constraint violation](/vibesenpai/dimensions/constraint-violation/).**
  If a stated rule forbade the extra work, the main kind is constraint violation,
  with `also overreach`.
- **Not [misread intent](/vibesenpai/dimensions/misread-intent/).** Different
  work on a wrong reading is a misread; more work on the right reading is
  overreach.
- **Not extra work nobody objected to.** Without the developer pushing back, it
  is not labelled.

## Example conversation

:::note[Illustrative]
The demo data has no overreach finding. This exchange was written for this page
in the shape of a real transcript. It was not found.
:::

> **Developer**, turn 20: "Fix the typo in the README heading."
>
> **Agent**, turns 21 to 30: fixes the typo, then reorders the README's sections
> and rewrites the install steps in two other docs.
>
> **Developer**, turn 31 (cited): "I only asked for the typo. Please put the other docs back."

What the finding records:

| | |
|---|---|
| Why | The developer asked for one typo fix and the agent also restructured three documents, which the developer asked to revert. |
| Established | not used for this kind |
| Cited turns | 30, 31 |

## How it's detected

The session is built into a packet and redacted. The extract stage finds
episodes without being shown any categories, each anchored by a quote that must
be found in the packet. The label stage then names the kind. The shared pipeline
is on [The judge pipeline](/vibesenpai/architecture/judge/).

What is specific to this kind: the label needs both substantial unrequested work
and the developer's push-back in the turns. There is no lookback gate.

![How an overreach finding is labelled](../../../diagrams/overreach.svg)

## Applicable fixes

A finding's own fix is shown first, under the finding. The dimension's fix is the
fallback, under the Overreach heading.

**The finding's own fix**, built from its evidence:

| Kind, in the pane's words | When | What it adds | Where | Apply |
|---|---|---|---|---|
| Claude Code asks you before this command runs, in every mode: | the developer forbade a command's verb in the quoted words, and the agent ran it | `"Bash(<command> *)"` in `permissions.ask` | `.claude/settings.local.json` | yes |
| Claude Code refuses an edit to this path and tells the agent why: | the agent wrote to a path outside the project | a `PreToolUse` hook on Edit, Write, MultiEdit and NotebookEdit that exits 2 for that path | `.claude/settings.local.json` | yes |

**A shared fix, when a question got an edit.** When the developer asked a question
(their prompt ends in `?`) and the agent wrote files in reply, in two or more
sessions, the pane offers "A helper that answers questions and cannot edit:", a
read-only subagent at `.claude/agents/ask.md`. The pane offers Apply.

**The dimension's fix**, shown when the finding has none of its own:

> A rule the agent reads in every session of this project:
>
> Do only what was asked. If something adjacent needs doing, say so and wait.

It is added to `.claude/rules/vibesenpai.md`, with one pointer line in
`CLAUDE.md`, and the pane offers Apply.

**Printed in the HTML report only, with no Apply** (`/vibesenpai:report`):

- A `Stop` hook that holds the diff to what was asked, with a placeholder for the
  paths:

  ```json
  { "hooks": { "Stop": [{ "hooks": [{ "type": "command",
      "command": "git diff --name-only | grep -vqE '<paths this task should touch>' && { echo 'changed files outside the task' >&2; exit 2; } || true" }] }] } }
  ```

- The same instruction as a prompt for one session: "For the rest of this
  session: do only what was asked. If you think something adjacent needs doing,
  say so and wait rather than doing it."
- When the conversation was compacted before the cited turn, the hook is replaced
  by a `SessionStart` hook with the `compact` matcher that runs
  `cat .claude/standing.md`.

A Stop hook stays printed until each snippet is bounded and tested: one that exits
2 with an unfilled placeholder would stop every turn.
