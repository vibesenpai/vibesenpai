---
title: The dimensions
description: What vibesenpai looks for, which tier each lives in, and which one does not work.
---

Two tiers, and we are explicit about which is which because they have very
different reliability.

## Rules — structural, no model

Cheap, deterministic, and they run on every session with no network.

### `edit_retry`

An edit the harness refused, which the agent then retried. Three reasons, and
they need different responses:

- **the file was not read first** — the harness already prevents this
- **the text did not match** — the anchor had changed since it was read
- **the target was ambiguous** — the anchor matched several places

```
Edit  src/api.ts   → File has not been read yet…
Read  src/api.ts
Edit  src/api.ts   → ok
```

**Measured: 380 of 1,139 sessions (33.4%)**, 927 instances, every one `certain`,
**0 false positives** hand-verified. This is the most thoroughly validated
thing here.

### `redundant_call`

The same call made again when nothing had changed between them.

Real, and it has **no fix** — re-reading a file is cheap and frequently the
right thing to do. It is reported so you can see it, not so you can act on it.

## The judge — reads conversation

These need [the judge](/vibesenpai/architecture/judge/) enabled.

| dimension | what it catches |
|---|---|
| `constraint_violation` | you stated a rule; it was not followed |
| `misread_intent` | it acted on a different reading of your request than you meant |
| `inaccurate_self_report` | it said work was done or passing when a turn shows otherwise |
| `overreach` | substantially more than you asked for |
| `other` | a real problem none of the above describes |

### `other` is load-bearing

Without an escape hatch, a judge that finds a real problem outside the four
categories has nowhere to put it — so it reports nothing, and the finding is
lost. `other` requires a short descriptor, and those accumulate so the missing
dimension can be *discovered* rather than guessed at.

### `overreach` does not work

**2 of 38** against labelled data, across two models and three pipeline
versions. Established, not provisional. Treat any `overreach` finding as a
reason to look rather than a conclusion. [Why it stays](/vibesenpai/work/limits/).

## Confidence

`certain` means the harness itself said so — an error field, an exit code, a
refusal message. `likely` means the pattern was inferred.

A `certain` finding can be trusted as a fact about what happened. `edit_retry`
is `certain` on every one of its 927 instances, which is why its false-positive
count is zero.
