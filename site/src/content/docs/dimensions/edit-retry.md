---
title: Edit retry
description: The edit tool refused an edit, and the agent tried the same file again.
---

## The dimension

| | |
|---|---|
| In the pane | Edit retry |
| Key | `edit_retry` |
| Tier | free check |
| On by default | yes, in the default preset `core` |
| Confidence | `certain` on every finding |

## Description

The agent called an edit tool, the tool itself refused the call, and the agent
edited the same file again before the developer's next prompt. It is the agent
working against the edit tool's exact-match contract.

What it is not:

- **Not a refusal the developer made.** A declined permission, or the developer's
  own hook blocking an edit, is their control working and is never counted.
- **Not a single refusal.** If the agent accepts the refusal and moves on, that is
  the tool doing its job. The retry is what makes it a finding.
- **Not a retry after a new instruction.** The attempt ends at the next developer
  prompt.

Measured over 1,139 sessions from the SWE-chat corpus (docs/dimensions.md,
2026-10-19): 380 sessions had a finding (33.4%), 927 instances, and the findings
read by hand (16 from that corpus and all 12 from the pinned test corpus) had no
false positives. How often each reason appeared:

| Reason | Instances |
|---|---|
| the file wasn't read first | 528 |
| the text didn't match | 224 |
| the file changed after it was read | 96 |
| the text matched several places | 59 |
| the edit changed nothing | 8 |
| the call was malformed | 8 |
| the file doesn't exist | 3 |
| reason unknown | 1 |

## Example conversation

From the public test data of [claude-code-log](https://github.com/daaain/claude-code-log) (MIT).

> **Developer**: "The redirection doesn't work :( we might need to move it to @vercel.json ?"
>
> **Agent**, turn 74: Edit `vercel.json`
>
> **Tool**, turn 75: refused. The file has not been read yet.
>
> **Agent**: Read `vercel.json`
>
> **Agent**, turn 78: Edit `vercel.json`, which succeeds.

In the pane, the row's headline is the developer's prompt. Opened, it lists the
attempt, the refusal and the retry by time, then:

| | |
|---|---|
| Reasons | `1× not read first` |

The pane prints the reason's key with spaces. The HTML report and the fix
evidence use the plain words in the table above.

## How it's detected

A detector reads structure, never message text: the compiler rejects a detector
that tries. This one reads:

- `tool_use` events for the four edit tools (Edit, Write, MultiEdit,
  NotebookEdit), with their file path and call id;
- each `tool_result`: whether it is an error, and whose error the harness's
  envelope says it is (the tool's, the developer's, their hook's);
- the order of events, and where the next developer prompt falls.

It fires when an edit's result is an error the tool raised, and another edit to
the exact same path follows before the next developer prompt. A call id can
repeat within one transcript, so each result is paired with the nearest call
before it.

After the finding exists, a label is attached from the start of the harness's
error message, such as `File has not been read yet`. The label names the finding;
it never decides it. A message that is not recognised gives "reason unknown", and
the finding stands.

![How an edit retry is found and labelled](../../../diagrams/edit-retry.svg)

## Applicable fixes

Edit retry has one fix at a time. The reasons across your findings are ranked by
count, and the first one in the table below with a rule decides the fix; reasons
with no rule are passed over. There are no per-finding fixes for the free checks.

| First ranked reason with a rule | Fix the pane offers | Apply |
|---|---|---|
| the text didn't match | A rule the agent reads in every session of this project: "Re-read right before editing if anything may have changed the file." | yes |
| the file changed after it was read | A rule the agent reads in every session of this project: "After a stale-read refusal, re-read before retrying the edit." | yes |
| the text matched several places | A rule the agent reads in every session of this project: "Quote enough context to make an edit target unique." | yes |
| the file wasn't read first | none | no |

The edit changed nothing, the file doesn't exist, the call was malformed, and
reason unknown have no rule and are passed over. If only those reasons occurred,
there is no fix.

Each rule is added to `.claude/rules/vibesenpai.md`, with one pointer line in
`CLAUDE.md`.

**The file wasn't read first has no fix on purpose.** Claude Code already refuses
an edit to a file that was not read, which is why these were refused; a rule
asking for it would describe behaviour that already complies. The report says
"Nothing to change" and shows the tokens those refusals cost. The demo data is in
this state: 8 of its 11 refusals are this reason, so the pane shows Edit retry
with no Fix section.

**In the HTML report** (`/vibesenpai:report`), each fix also has a prompt for one
session, such as "For the rest of this session: before editing, re-read the exact
region you are about to change if anything may have altered it since you last
read it — a linter, a formatter, another tool, or your own earlier edit." It has
no Apply.
