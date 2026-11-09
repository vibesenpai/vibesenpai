---
title: Measuring ourselves
description: What our own accuracy is, what it is not, and why we will not call it precision.
---

Most tools that find problems in your code do not tell you how often they are
wrong. This page does, and it will probably undersell us.

## The number

The judge — the model pass that reads conversation rather than
structure — agrees with published, human-validated labels on **165 of 232
sessions**.

```
                     session        episode        claim
  old rubric         104/232  45%   151/437  35%   96/557  17%
  new rubric         129/232  56%   196/437  45%  119/557  21%
  + two-stage        165/232  71%   290/437  66%  175/557  31%
```

Three denominators, because they answer different questions. **Session-level**
asks "did we find the problem in this session at all".
**Episode-level** asks "did we find this specific incident". **Claim-level**
additionally requires us to have given it the same label the humans did.

Every figure requires the finding to sit within 25 turns of where the labellers
put it. None of them credits being vaguely in the neighbourhood.

## Why that is not precision, and we will not call it

The labels we are agreeing with were produced by **a model**, with human
expert validation on a sample — 0.93 extraction precision against two experts
on 200 of 16,118 records, with 0.83 inter-rater agreement between the experts
themselves. Strong, and reported by the study's own authors. Not the same thing
as hand-labelled ground truth.

This project keeps three scoreboards and refuses to conflate them:

| tier | source | what it proves |
|---|---|---|
| **Synthetic** | hand-written fixtures, one per dimension | the detector fires on the shape it targets |
| **Silver** | published model-generated labels | broad agreement with the literature |
| **Gold** | hand-labelled by us against real sessions | real precision and recall |

**The gold tier has zero items in it.** So every number above is *silver
agreement*, and there is no headline accuracy figure for this tool yet. When
there is one, it will be smaller than 71% and it will mean more.

## What the disagreement is made of

Of the sessions we and the labellers disagree about, some we genuinely missed.
But some we disagree about **by design**: the study only counts a misalignment
when the developer visibly pushed back, because without that they have no
ground truth to label against. We deliberately did not adopt that trigger — a
mistake you never noticed is among the most valuable things this tool could
show you — so a finding with no visible correction is counted against us by an
instrument that cannot see it.

That cuts the other way too, and we are not going to pretend otherwise: it
means some of our disagreement is us being wrong, and the gold set that would
separate the two does not exist.

## The precision side, such as it is

On **319 sessions the same pipeline examined and found nothing in**, we report
149 findings.

Those are false-positive *candidates*, not confirmed false positives. The
study's own first pass is 46% false positive by its authors' measurement, and
only **1.6% of that is genuine extractor error** — the rest is their corpus
lacking things ours has (tool calls, tool results, the repository) and their
scope being narrower than ours. Treat 149 as an upper bound on our noise, not a
count of our mistakes.

## One dimension does not work, and we ship it anyway

`overreach` scores **2 of 38**. Across two models and three pipeline versions.
It is not a tuning problem and we have stopped pretending it might be.

It stays in the table because the alternative is a table that quietly omits its
failures. If you see an `overreach` finding, treat it as a prompt to look rather
than a conclusion.

## Reproducing this

`npm run gold` scores the judge against the labelled set. It needs the
replication package for [arXiv 2605.29442](https://arxiv.org/abs/2605.29442)
and the SWE-chat transcripts, which are gated and roughly 47 GB — so this
particular number is not reproducible by a casual reader, and saying "every
number here is reproducible" would be false.

What *is* reproducible without any download:
`npm test` (the whole suite, no network) and `npm run verify:corpus`, which fetches
two small MIT-licensed transcript corpora and fails if any published count
drifts.
