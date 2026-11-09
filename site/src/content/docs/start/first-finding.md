---
title: Your first finding
description: One real finding read the way the pane shows it, what each answer does, and why "nothing flagged" is a result.
---

A finding is evidence, not a verdict. It says where to look and why; what it was is yours to
decide. This page reads one real finding the way the pane shows it.

From the public test data of [claude-code-log](https://github.com/daaain/claude-code-log) (MIT).

## The row

Under **Inaccurate self report** in **What went wrong, by kind**, the row's headline is the
developer's own request, in italics and cut to fit:

> *"OK, we're going to make a little experiment here. Pretend we have a list of tasks…"*

The developer asked the agent to hand three research tasks to three teammates, each in its
own worktree, merge their work, then send them a second round. Under the headline are the
date, the session and the time of the first cited turn.

## Opened

<!-- screenshot: finding.png -->

The pane reads the conversation around the cited turns from the transcript, in place. The
cited messages are marked `▶`:

- **Agent**, after merging round one:
  *"Round 1 merged cleanly. Now I'll dispatch round 2 to all three teammates in parallel via
  SendMessage. Round 2 dispatched to alice, bob, carol. Waiting for their replies to come in."*
- **You**, about ten minutes later: *"Well, the subagents seem to be either stuck or done... can
  you check?"*
- **Agent**: *"Worktrees are clean and still at round-1 commits — no uncommitted work. The
  SendMessage landed in their inboxes but the agents had already terminated after round 1."*

Then:

**Why:** *The agent reports "Round 2 dispatched to alice, bob, carol. Waiting for their
replies" when the teammates had already terminated, so its account of the current state is
wrong.*

**Fix:** this finding has no fix of its own, so its kind's fix is shown:

> A rule the agent reads in every session of this project:
> *Never report work as done or passing unless a command in this session shows it; quote the output.*
> Added to .claude/rules/vibesenpai.md

with **Apply** ([Fixes and Apply](/vibesenpai/start/fixes/)), and under it **Finding is wrong**
and **Hide**. **Not the agent's fault** is not offered here: the quote is the agent's words,
not the developer's.

## How to read it

The three cited turns make the case without the model's account: the agent said it was
waiting for replies; the developer had to ask; the agent's own check found the teammates had
stopped after round one, so no reply could come. The **Why** line is the model's summary of
that. The turns are the evidence.

A model finding can be wrong. When the conversation does not bear it out, that is what
**Finding is wrong** is for.

## What each answer does

| answer | when | effect |
|---|---|---|
| **Finding is wrong** | it did not happen as described | hidden, `Hidden. Noted as a wrong finding.`; it counts nowhere |
| **Not the agent's fault** | it happened, but it was not the agent's mistake. Offered only when the quote is yours | hidden, `Hidden. It doesn't count against the agent.` |
| **Hide** | you have seen it | hidden, `Hidden. It still counts.` |
| *(no answer)* | | the finding stands, and its fix stays on offer |

Each answer shows at once and offers **Undo**. Nothing is deleted: your answers are kept in
the local store, and **Restore all** on the Health tab brings hidden findings back into view.

## When nothing is flagged

When nothing has been found, the Findings tab says so, with how many sessions were read. For example:

```
Nothing flagged in 40 sessions read.
```

That is a result. The free checks and the model reads ran over those sessions and found
nothing they could anchor to a turn. Nothing is added to make the pane look busy.

## Across your history

**Open full report** at the bottom of the Findings tab, or
[`/vibesenpai:report`](/vibesenpai/commands/report/), writes the same findings across your
history as one HTML file.
