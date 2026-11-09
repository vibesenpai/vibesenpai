---
title: Overreach
description: Substantial work beyond what was asked, which the developer pushed back on. It does not work yet.
---

The agent did a lot more than you asked, and you pushed back. This dimension does
not work reliably yet: an overreach finding points at turns worth reading; it is
not a conclusion.

:::caution[It does not work yet]
Against hand-labelled data, overreach agreed on 1, 1 and 2 of 38 episodes,
across three pipeline versions and two models
([the graveyard](/vibesenpai/work/graveyard/)). It still runs, because retiring
a dimension is a decision nobody has made yet. See
[Limits](/vibesenpai/work/limits/).
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

The agent did substantial work beyond what was asked, and you pushed back on
it. The problem is the agent acting without being asked. Your push-back is
required for this kind, though the other kinds no longer need it.

What it is not:

- **Not [constraint violation](/vibesenpai/dimensions/constraint-violation/).**
  If a stated rule forbade the extra work, the main kind is constraint
  violation, `also overreach`.
- **Not [misread intent](/vibesenpai/dimensions/misread-intent/).** Different
  work on a wrong reading is a misread. More work on the right reading is
  overreach.
- **Not extra work nobody objected to.** Without your push-back, it is not
  labelled.

## Example conversation

:::note[Illustrative]
The demo data has no overreach finding. This exchange was written for this page
in the shape of a real transcript.
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
| Cited turns | 30, 31 |

## How it's detected

A model reads a redacted copy of the session, finds the episode, anchors it to
a quote, and names its kind. The shared steps are on
[The judge pipeline](/vibesenpai/architecture/judge/).

What is specific to this kind: the turns must show both substantial unrequested
work and your push-back. There is no lookback gate.

![How an overreach finding is labelled](../../../diagrams/overreach.svg)

## Applicable fixes

Which fix the pane shows first is explained in
[How a fix is chosen](/vibesenpai/dimensions/#how-a-fix-is-chosen).

### The finding's own fix

**Claude Code asks you before this command runs, in every mode:**
- When: you forbade a command, and the agent ran it.
- Adds: `"Bash(<command> *)"` to `permissions.ask`.
- Lands in: `.claude/settings.local.json`.
- Apply: yes.

**Claude Code refuses an edit to this path and tells the agent why:**
- When: the agent wrote to a path outside the project.
- Adds: a `PreToolUse` hook on Edit, Write, MultiEdit and NotebookEdit that
  blocks that one path.
- Lands in: `.claude/settings.local.json`.
- Apply: yes.

### When a question got an edit

**A helper that answers questions and cannot edit:**
- When: you asked a question (your prompt ended in `?`) and the agent wrote
  files in reply, in two or more sessions.
- Adds: a read-only subagent named `ask`.
- Lands in: `.claude/agents/ask.md`.
- Apply: yes.

### The kind's fix

**A rule the agent reads in every session of this project:**
- Adds: `- Do only what was asked. If something adjacent needs doing, say so and wait.`
- Lands in: `.claude/rules/vibesenpai.md`, with one pointer line in `CLAUDE.md`.
- Apply: yes.

### Printed in the HTML report only

These have no Apply. They appear in `/vibesenpai:report`.

- **A `Stop` hook that holds the diff to what was asked.** The paths are a
  placeholder for you to fill in:

  ```json
  { "hooks": { "Stop": [{ "hooks": [{ "type": "command",
      "command": "git diff --name-only | grep -vqE '<paths this task should touch>' && { echo 'changed files outside the task' >&2; exit 2; } || true" }] }] } }
  ```

  When the conversation was compacted before the cited turn, this is replaced by
  a `SessionStart` hook with the `compact` matcher that runs
  `cat .claude/standing.md`.
- **A prompt for one session:** "For the rest of this session: do only what was
  asked. If you think something adjacent needs doing, say so and wait rather
  than doing it."

A `Stop` hook stays printed only: one that blocks with an unfilled placeholder
would stop every turn.
