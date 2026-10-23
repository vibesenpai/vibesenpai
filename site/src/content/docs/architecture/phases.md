---
title: Phases of a run
description: Nothing slow happens in a hook, and nothing spends your quota unless you asked.
---

Two rules govern when anything runs, and both are load-bearing enough to be
asserted by tests.

![The hook lifecycle](../../../diagrams/hook-lifecycle.svg)

## Nothing slow happens in a hook

A hook has milliseconds. Both of ours read a JSON file, print or spawn, and
exit — they never wait for analysis. The slow work happens in a detached child,
and `standing.json` is the buffer between that slow producer and the fast
reader.

```
  scan, 231 sessions              0.22s
  standing --refresh              0.64s
  /agentsensei:now                0.41s
  a judge pass, one session        ~60s   ← the only slow thing
```

So the report you see at the top of a session is the **last completed pass**,
not one computed while you waited. Degrading to slightly stale beats degrading
to a spinner.

## Nothing spends unless you asked

The judge is on from installation. That is only defensible because of where it
fires: **the `Stop` hook does not spawn it.**

It used to. On a byte cadence, every time the live session had grown enough —
which was fine while the judge was something you had switched on yourself, and
indefensible the moment it ships on. A detached process spending your money at
every turn boundary is precisely the failure this tool exists to detect, and
shipping it would make the product the thing it criticises.

So the trigger moved to the command. `/agentsensei:now` judges the session you
are asking about, when you ask. The hooks only refresh the local standing,
which costs nothing.

| phase | what it does | spends? |
|---|---|---|
| `SessionStart` | prints the last pass's report; refreshes standing if stale | no |
| `Stop` | refreshes standing if stale | **no** |
| `/agentsensei:now` | renders instantly, then judges **this session** | yes, ~58k tokens |
| `judge --backlog` | the rest of your history, after showing the cost | yes, on `--apply` |

`now` judges **one** session. The backlog on a typical machine is eighteen,
which would be over a million tokens — so that is a separate command that
prints what it would cost and sends nothing until told twice.

## If something breaks

Every entry point exits 0 whatever happens. A circuit breaker trips after five
consecutive failures and is **shared**, so a tripped breaker also stops the
standing refresh — one broken thing should not keep retrying on your time. One
success closes it completely.

An unreadable breaker file is treated as closed, because a corrupt file must
not permanently disable the tool.
