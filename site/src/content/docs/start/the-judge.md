---
title: Turning the judge on
description: The opt-in model pass — what it finds, what it sends, what it costs.
---

Two rule detectors run with no model at all. The judge is different: it reads
the conversation, it sends data off your machine, and it is **off by default**.

## Why it exists

The structural well is dry, and that was measured rather than assumed.

Edit and Write account for **998 of roughly 1,400 tool refusals** in the public
corpus, and `edit_retry` already covers both. There is no second structural
detector hiding in the failure data.

The research this project builds on — [arXiv 2605.29442](https://arxiv.org/abs/2605.29442),
20,574 sessions — found the remaining failures are visible in what the developer
*said*, "not on structural signals such as tool-call errors, exit codes, or test
failures."

This project proved it the expensive way: `inaccurate_self_report` was first
built as a rule detector and died at **0 true positives against 5 false**. It
works now because a model reads the conversation instead.

## Enabling it

```bash
agentsensei judge                      # what one pass would send. Sends nothing
agentsensei judge --enable --apply     # two steps, deliberately
agentsensei judge --status             # what is pending, roughly how long
```

The first command builds a real packet from your real sessions and prints its
size, the per-stage overhead, and that output is roughly 98% thinking tokens.
Nothing is sent.

## What it costs, and how long

It runs **detached**, after your turn ends, so it never adds latency to
anything you are doing. It is also the only slow part of this tool — the local
pipeline indexes 231 sessions in about 0.2 seconds; the judge takes minutes,
because it waits on a model.

```
agentsensei judge --status
```

```
  judged     11 session(s) · 19 finding(s)
  pending    5 session(s) · about 5 minutes at ~30s per call
  runs detached after your next turn ends.
  spent      12 call(s) · 426,192 in · 41,486 out
```

The ~30s figure is measured across three runs of very different sizes, so the
estimate has a basis. Spend is reported in **tokens, never dollars** — the
dollar figure depends on your plan and is notional on a subscription.

## How it works

Two stages, which is the paper's architecture and measurably better than doing
it in one:

1. **Extract** reads the transcript and writes up each episode in prose —
   quoting the turn, saying what diverged. It is never shown the category list.
2. **Label** reads only those records, never the transcript, and assigns the
   dimension. It reasons before it labels.

Splitting them took session-level agreement from **129/232 to 165/232**, and
more than doubled `misread_intent` — the dimension hardest to pick while still
reading. Stage two is cheap because a record is a few hundred tokens against a
whole session.

## What it sends

Redacted transcript text, checked immediately before every call: if redaction
would still change anything, **the send is aborted**.
[The specifics](/agentsensei/trust/egress/).

## Turning it off

```bash
agentsensei judge --disable --apply
AGENTSENSEI_DISABLE=1              # or stop everything, immediately
```
