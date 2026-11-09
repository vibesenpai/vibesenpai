---
title: Repeated call
description: The same call made again, with the same answer, when nothing had changed between them.
---

The agent made the same tool call more than once, got the same answer each time,
and nothing had changed in between. The finding lists the repeated calls.

## The dimension

| | |
|---|---|
| In the pane | Repeated call |
| Key | `redundant_call` |
| Tier | free check |
| On by default | no. It is in the `standard` preset; the default is `core`. Set `VIBESENPAI_PRESET=standard` or `"preset": "standard"` in the config file ([Reference](/vibesenpai/reference/)). |
| Confidence | `certain`, or `high` when a call clipped its own output |

## Description

The agent made the same tool call two or more times and got the same answer
each time. Between the first and the last call there was no edit and no new
prompt from you.

What it is not:

- **Not a re-run after a change.** Running the tests, editing, and running them
  again is an informed retry. An edit between the calls rules it out.
- **Not waiting.** Checking on a job every minute repeats the same call on
  purpose. A median gap of 60 seconds or more between the calls rules it out.
- **Not an edit.** An edit's output is the file's new contents, so the same
  output does not mean nothing changed. Edit tools are left out.

Off by default, because it is rare ([How it was measured](/vibesenpai/architecture/measurements/#the-free-checks)).

## Example conversation

:::note[Illustrative]
The public test data has no repeated call, even with the `standard` preset on. This
sequence was written for this page in the shape of a real transcript.
:::

> **Developer**: "Why does the build pick up the wrong port?"
>
> **Agent**, turn 40: Read `src/config.ts`
>
> **Agent**, turn 44: Read `src/config.ts`, 12 seconds later, same contents
>
> **Agent**, turn 47: Read `src/config.ts`, 9 seconds later, same contents

The finding reads: `Read src/config.ts ran 3× with the same answer and nothing
changed between`. In the pane, the headline is your prompt, and opening it lists
the three calls in order.

## How it's detected

A free check reads the transcript's structure, never message text. This one
reads each tool call's name, a fingerprint of its arguments, a fingerprint of
its output, its time, and the edits and prompts around it.

1. Group every call in the session by tool, arguments and output. A call with no
   recorded output never matches. Tools that check on background work
   (BashOutput, TaskOutput, Monitor, ListAgents) and edit tools are left out.
2. A group of 2 or more calls is a candidate.
3. It is dropped if an edit or a prompt from you falls between its first and
   last call.
4. It is dropped if the median gap between calls is 60 seconds or more.

A command that clips its own output, such as `| head -30`, leaves only the start
to compare. Such a finding is downgraded to `high`, never dropped.

![How a repeated call is found](../../../diagrams/redundant-call.svg)

## Applicable fixes

There is no fix: re-reading can be correct, so nothing is offered. The pane
shows the finding with no fix, and the HTML report prints that sentence.
