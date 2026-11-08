---
title: The judge pipeline
description: Extract without the categories, then label without the transcript — and four places redaction happens.
---

The judge is one model, called twice, on two different things.

![The two judge stages](../../../diagrams/judge-stages.svg)

## Why two stages

**Stage A is never shown the categories.** It reads the session and writes up
each episode in prose: what was said, what diverged, with a verbatim quote.
Asking only "where did this collaboration break down" and nothing about
taxonomy.

**Stage B never sees the transcript.** It reads the records stage A produced
and assigns a dimension to each.

Splitting them took session-level agreement from **129/232 to 165/232**, and
more than doubled `misread_intent` — the dimension hardest to pick while still
reading. Stage B is cheap, because a record is a few hundred tokens against a
whole session.

The output schema puts `reasoning` **before** `dimension`. For a model
generating left to right that is the difference between reasoning toward a
label and justifying one already emitted.

## Quotes anchor; turn numbers do not

Every record must carry a verbatim quote. A quote is self-validating — it is
either in the transcript or it is not. A turn number is a second numbering the
model has to track, and every apparent hallucination we investigated turned out
to be a citation error rather than an invented claim.

A finding whose quote cannot be located in the packet is **discarded**.

## Redaction happens four times

Not once, and the repetition is deliberate.

1. **In the parser**, at construction — nothing downstream holds raw text.
2. **Inside truncation**, by moving the cut. Slicing through a `[USER]` marker
   leaves `/Users/[USER`, which redaction then *repairs* — turning clean text
   into text that fails the gate.
3. **At the end of packet assembly**, because assembly itself can create a
   pattern neither input contained.
4. **Immediately before each send**, as an assertion rather than a step:

```
  redact(packet) === packet   or the send aborts
```

Both calls are gated separately, even though stage B's quotes came from an
already-gated stage A packet — it is a different string leaving the machine, so
it is checked again.

The test is equality, not idempotence. "Redacting twice gives the same answer"
is weaker and returns true for text redaction would still change. This project
got that distinction wrong once.

## What it costs, and why it batches

One invocation of the model carries **26,384 tokens of overhead** before our
packet — measured over 98 calls. A typical session packet is ~8,634 tokens, so
the overhead dwarfs the payload, and two stages pay it twice.

That is the whole argument for batching: sessions are **filled to a ceiling,
never truncated to fit it.** Whole sessions are appended while the packet stays
under 60,000 tokens; the rest wait for the next pass. A session too large to
fit alone is skipped and recorded as a failure rather than cut in half.

## The ledger is a byte offset

Not a boolean, and not a parser version:

```json
"ledger": { "a1b2c3d4-…": 1048576 }
```

A live session keeps growing, so "judged" is a **position**, not a state. Key
it any other way and a session is judged once at turn 50 and never again at
turn 800.

The ledger advances after stage A, before stage B is interpreted — *if anything
downstream throws, the batch is still marked paid for, because it was.* The
cost of that honesty is real: a stage-B failure loses those episodes
permanently.

## The child is isolated

The model is called through your own `claude` CLI, in a child process with:

- `VIBESENPAI_DISABLE=1`, so it cannot recursively analyse itself
- a dedicated working directory that transcript discovery filters out
- `--allowed-tools ''` — it reads and answers, it cannot act

The isolation was learned the hard way: three probe calls once took a machine
from 9 discovered sessions to 12, because the judge's own sessions were being
counted as the user's.
