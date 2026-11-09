---
title: The judge pipeline
description: Extract without the categories, label without the transcript, anchor every finding to a quote, and check the lookback before keeping it.
---

The judge is one model, Claude Haiku by default, called twice per batch on two different
things, through your own `claude` CLI. It runs in the background, started by the
`Stop` hook ([Phases of a run](/vibesenpai/architecture/phases/)).

![The two judge stages](../../../diagrams/judge-stages.svg)

## Why two stages

**Stage A is never shown the categories.** It reads the sessions and writes up
each episode in prose: what was said, what diverged, with a verbatim quote. It
is asked only where the collaboration broke down, and nothing about taxonomy.

**Stage B never sees the transcript.** It reads the records stage A produced and
assigns a dimension to each.

Splitting them took session-level agreement from **129/232 to 165/232**
([docs/eval.md](https://github.com/vibesenpai/vibesenpai/blob/main/docs/eval.md)).
Stage B is cheap, because a record is a few hundred tokens against a whole
session.

The output schema puts `reasoning` **before** `dimension`. For a model
generating left to right that is the difference between reasoning toward a label
and justifying one already emitted.

### Secondary kinds

A label may add **up to two** more kinds beside its main dimension, because the
kinds overlap. The main dimension decides the finding's id, the lookback gate
and its fix.

## Quotes anchor; turn numbers do not

Every record must carry a verbatim quote. A quote is self-validating: it is
either in the packet or it is not. A turn number is a second numbering the model
has to track.

A finding whose quote cannot be located in the packet is **discarded**.

## The lookback gate

A `misread_intent` or `constraint_violation` finding must say where the
expectation was set **before** the agent acted: an earlier prompt, an
instruction Claude Code loaded (a `CLAUDE.md` or a rule file), or the developer
referring to an earlier decision. The label stage is shown the session's earlier
prompts and loaded instructions for this.

The gate checks the cited quote against what was actually there. A finding with
no earlier source is dropped as a suggestion rather than a mistake, and the run
records how many were dropped. The lookback is on by default
(`src/judge/lookback.ts`).

## Batches, and sessions too big for one

Each model call carries about **26k tokens of invocation overhead** before our
packet (`src/judge/limits.ts`), and two stages pay it twice. So sessions share a
call: whole sessions are added to a batch while it stays under **60,000
tokens**. A pass sends up to **3 batches at once**.

A session too big for one packet is **read in windows**, in order. Each window
carries what came before it: failures still open, findings already reported, and
how many turns were read. A single turn too big for any packet (only a prompt
can be, since prompts are never cut) is read in parts, by character range.

## The ledger is a byte offset

The `ledger` table in `store.db` holds, per session, **how many bytes have been
read**. A live session keeps growing, so "read" is a position, not a state: a
session read at turn 50 is read again from there at turn 100.

Progress and cost are kept apart:

- **Spend is recorded when a call returns**, whatever happens afterwards: it
  was paid for.
- **The ledger moves only with the findings**, in the same transaction. If
  stage B fails, nothing is recorded and those bytes are read again on the next
  pass. A failure re-bills; it never loses episodes.

## Redaction happens four times

1. **In the parser**, at construction: nothing downstream holds raw text.
2. **Inside truncation**, by moving the cut. Slicing through a `[USER]` marker
   leaves `/Users/[USER`, which redaction then *repairs*, turning clean text
   into text that fails the gate.
3. **At the end of packet assembly**, because assembly itself can create a
   pattern neither input contained.
4. **Immediately before each send**, as an assertion rather than a step:

```
  redact(packet) === packet   or the send aborts
```

Both calls are gated separately, even though stage B's quotes came from an
already-gated stage A packet: it is a different string leaving the machine.

The test is equality, not idempotence. "Redacting twice gives the same answer"
is weaker and returns true for text redaction would still change.

## Fencing

A pass holds a lease from the job supervisor. Before every model call and every
write, the judge checks it still holds that lease. A pass that was superseded,
for example after it was reclaimed as hung, sends and writes nothing more.

## The child is isolated

The model is called through your own `claude` CLI, in a child process with:

- `VIBESENPAI_DISABLE=1`, so the child's own hooks do nothing
- a dedicated working directory that transcript discovery filters out, so the
  judge never reads its own sessions as yours
- `--allowed-tools ''`: it reads and answers; it cannot act
