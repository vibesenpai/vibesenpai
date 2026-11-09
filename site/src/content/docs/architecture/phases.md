---
title: Phases of a run
description: Nothing slow happens in a hook, only the Stop hook spends, and a failing job heals at the next hook.
---

This page answers when vibesenpai runs, which part spends tokens, and what
happens when a background job fails.

Two Claude Code hooks start everything: `SessionStart` and `Stop` (which fires
when a turn ends). Neither waits for analysis.

![The hook lifecycle](../../../diagrams/hook-lifecycle.svg)

## Does a hook slow my session?

No. Each hook has a 5-second timeout and exits 0 whatever happens (`|| true` in
`hooks/hooks.json`). A hook checks which background jobs are due, starts them as
separate processes, and exits.

So what you see at session start is the **last completed pass**, not one
computed while you waited.

## What spends tokens?

Only the judge, and only the `Stop` hook starts it.

| phase | what it does | spends? |
|---|---|---|
| `SessionStart` | shows the last pass's summary as a `systemMessage`; starts the standing pass if stale | no |
| `Stop` | starts the standing pass if stale, and the judge if due and within limits | **yes**, within limits |
| `/vibesenpai:insights` | reads what the passes stored | no |
| `/vibesenpai:report` | writes the HTML report from what the passes stored | no |
| `/vibesenpai:judge on` / `off` | changes a setting | no |

The standing pass computes the free checks over every session. The judge is
the model pass.

The judge is due when the live session has about 50 new turns since it was last
read, or when a past session in the catch-up has never been read. Two limits
apply (`src/judge/limits.ts`):

- **2M tokens a day.** If what is left today cannot cover even an empty batch,
  no pass starts.
- **A catch-up of 200 past sessions**, newest first, fixed the first time the
  pass runs.

[What is sent, and what it costs](/vibesenpai/start/sends-and-costs/)

## What happens when a job fails or hangs?

Every background pass runs under a supervisor (`src/supervise/`):

- A pass holds a lease, sends a heartbeat, and stops itself at its deadline.
- The next hook that runs that job reclaims a pass that died or hung. For the
  judge, that is the `Stop` hook.
- A live process is never reclaimed on time alone.
- The judge checks it still holds its lease **before every model call and every
  write**, so a replaced pass sends nothing more.

Failed passes retry on a schedule:

| kind of failure | what happens |
|---|---|
| **free** (nothing was billed) | retries after 5 minutes, 30 minutes, 2 hours, 12 hours, then every 24 hours |
| **paid** (a model call was billed) | retries the same way; after **3 in a row**, the judge holds until `/vibesenpai:judge on` |

One success clears the count. A failing job is stated at session start as one
plain fact.
