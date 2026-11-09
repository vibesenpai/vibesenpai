---
title: Constraint violation
description: The agent did not follow a rule that was stated literally before it acted.
---

You stated a rule plainly, such as "don't push", and the agent broke it. The
finding shows where the rule was set and the turn where it was broken.

## The dimension

| | |
|---|---|
| In the pane | Constraint violation |
| Key | `constraint_violation` |
| Tier | model read |
| On by default | yes, with the model reads (`/vibesenpai:judge off` turns them off) |
| Confidence | the model's own rating (high, medium or low), stored per finding |

## Description

A constraint violation is an instruction that was stated literally, which the
agent did not follow. It covers:

- prohibitions ("don't push");
- allow-lists ("only touch these files");
- a constraint repeated more than once;
- required process steps.

The rule can come from your prompt or from an instruction the agent had loaded:
a project instruction file, a skill, or a slash command's written procedure. A
skipped step in a command's procedure counts only if you objected or the outcome
changed.

What it is not:

- **Not [misread intent](/vibesenpai/dimensions/misread-intent/).** A misread is
  a request that left room and was filled the wrong way. A violation is a rule
  with no room in it.
- **Not [overreach](/vibesenpai/dimensions/overreach/).** Doing more than asked
  is overreach, unless a stated rule forbade it. Work that is both is labelled
  constraint violation, `also overreach`.
- **Not a new preference.** A requirement you bring to work already in progress
  was not set before the agent acted, so it is not counted.

## Example conversation

:::note[Illustrative]
The public test data has no constraint violation. This exchange was written for this
page in the shape of a real transcript.
:::

> **Developer**, turn 3: "Fix the failing lint step. Don't push anything; I'll review the diff first."
>
> **Agent**, turns 4 to 11: edits two files, runs the linter, then runs
> `git push origin lint-fix`.
>
> **Developer**, turn 12 (cited): "I said not to push. Please don't push until I've looked."

What the finding records:

| | |
|---|---|
| Why | The developer said not to push before reviewing, and the agent pushed the branch anyway. |
| Established | turn 3, "Don't push anything; I'll review the diff first." |
| Cited turns | 11, 12 |

The pane shows your quote as the headline, then the conversation around the
cited turns, then **Why**. Where the rule was established is not shown in the
pane; the HTML report shows it.

## How it's detected

A model reads a redacted copy of the session, finds the moment, anchors it to
a quote, and names its kind. The shared steps are on
[The judge pipeline](/vibesenpai/architecture/judge/).

One check is specific to this kind: the **lookback gate**. The finding must name
where the rule was set before the agent acted:

- an earlier prompt;
- a line of a loaded instruction file;
- or your own words saying it was settled before.

That quote is then checked against what was sent. With no source, or a
quote that cannot be found, the finding is dropped.

![How a constraint violation is labelled and gated](../../../diagrams/constraint-violation.svg)

## Applicable fixes

Which fix the pane shows first is explained in
[How a fix is chosen](/vibesenpai/dimensions/#how-a-fix-is-chosen).

### The finding's own fix

Built from the finding's evidence. The first one that fits is offered.

**Claude Code asks you before this command runs, in every mode:** when you
forbade a command and the agent ran it
([details](/vibesenpai/dimensions/#a-command-you-forbade)). For the example
above, it adds `"Bash(git push *)"`.

**Claude Code refuses an edit to this path and tells the agent why:**
- When: the agent wrote to a path outside the project.
- Adds: a `PreToolUse` hook on Edit, Write, MultiEdit and NotebookEdit that
  blocks that one path.
- Lands in: `.claude/settings.local.json`.
- Apply: yes.

**A test that fails when this rule is broken:**
- When: the rule was already in a loaded instruction file, and was broken anyway.
- Adds: a request for a test, lint rule or type constraint. The agent shows it to
  you before adding it.
- Lands in: a test or check in this project.
- Apply: yes.

**A rule the agent reads when it opens these files:**
- When: the rule was set in an earlier prompt, and 1 to 5 project files were
  written.
- Adds: `- Standing instruction from the developer: "<your words>"`, scoped to
  those files.
- Lands in: its own file under `.claude/rules/vibesenpai/`.
- Apply: yes.

**A rule the agent reads in every session of this project:**
- When: the rule was set in an earlier prompt.
- Adds: `- Standing instruction from the developer: "<your words>"`.
- Lands in: `.claude/rules/vibesenpai.md`.
- Apply: yes.

Your words are used only when they are 240 characters or fewer.

### The kind's fix

**A rule the agent reads in every session of this project:**
- Adds: `- Before any edit or command, check it against every constraint stated earlier in the conversation, and name the one you checked.`
- Lands in: `.claude/rules/vibesenpai.md`, with one pointer line in `CLAUDE.md`.
- Apply: yes.

### Printed in the HTML report only

These have no Apply. They appear in `/vibesenpai:report`.

- **A `Stop` hook that checks the diff before the turn can end.** The paths are a
  placeholder for you to fill in:

  ```json
  { "hooks": { "Stop": [{ "hooks": [{ "type": "command",
      "command": "git diff --name-only | grep -qE '<paths you said not to touch>' && { echo 'touched a path you asked me not to' >&2; exit 2; } || true" }] }] } }
  ```

  When the conversation was compacted before the cited turn, this is replaced by
  a `SessionStart` hook with the `compact` matcher that runs
  `cat .claude/standing.md` (a file you create with your standing instructions),
  so they are read again after each compaction.
- **A prompt for one session:** "For the rest of this session, before any edit or
  command: check it against every constraint stated earlier in this
  conversation, and say which one you checked against."

A Stop hook has no Apply: it needs your paths or test command filled in, and an
unfinished one would block every turn.
