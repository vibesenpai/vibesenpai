---
title: How it was measured
description: Every measured figure behind the docs, in one place, with its source.
---

The rest of the docs describe what vibesenpai does. This page holds the figures behind those
descriptions: how accurate the model reads are, how often each free check fires, and the numbers
that removed the detectors in [the graveyard](/vibesenpai/work/graveyard/).

## The data

| data | what it is | used for |
|---|---|---|
| [SWE-chat](https://huggingface.co/datasets/SALT-NLP/SWE-chat) | 1,139 real Claude Code sessions, public | how often each free check and graveyard candidate fires |
| the labelled set from [arXiv 2605.29442](https://arxiv.org/abs/2605.29442) | 232 sessions whose breakdowns were labelled by a model and checked by people on a sample | the model reads' accuracy |
| [claude-code-log](https://github.com/daaain/claude-code-log) test data | 101 public transcripts, MIT | the examples and samples in these docs |

Every frequency comes from `npm run measure` over a pinned corpus
([Contribute](/vibesenpai/contribute/)).

## The model reads

| figure | value | source |
|---|---|---|
| sessions where the findings agree with the labelled set | 165 of 232 | [docs/eval.md](https://github.com/vibesenpai/vibesenpai/blob/main/docs/eval.md) |
| the same, before the two stages were split | 129 of 232 | [docs/eval.md](https://github.com/vibesenpai/vibesenpai/blob/main/docs/eval.md) |

The labels were made by a model and checked by people on a sample, so there is no precision
figure. [The judge pipeline](/vibesenpai/architecture/judge/#why-two-stages) explains the two
stages.

### Overreach and the other kinds

In the labelled set, 37 of 38 overreach episodes also carry a misread-intent or
constraint-violation label. The model reads find most of those episodes at the right turns, and
usually name one of the other two as the main kind
([GRAVEYARD.md](https://github.com/vibesenpai/vibesenpai/blob/main/GRAVEYARD.md)). This is why a
finding can carry more than one kind
([The dimensions](/vibesenpai/dimensions/#one-finding-more-than-one-kind)).

## The free checks

Over the 1,139 SWE-chat sessions
([docs/dimensions.md](https://github.com/vibesenpai/vibesenpai/blob/main/docs/dimensions.md),
[docs/findings-frequency.md](https://github.com/vibesenpai/vibesenpai/blob/main/docs/findings-frequency.md)):

| check | sessions with a finding | read by hand |
|---|---|---|
| [Edit retry](/vibesenpai/dimensions/edit-retry/) | 380 (33.4%), 927 retries in all | 16 from SWE-chat and all 12 from the pinned test corpus; no false positives |
| [Repeated call](/vibesenpai/dimensions/redundant-call/) | 0.4%, which is why it is off by default | |

How often each edit-retry reason appeared:

| Reason | Retries |
|---|---|
| the file wasn't read first | 528 |
| the text didn't match | 224 |
| the file changed after it was read | 96 |
| the text matched several places | 59 |
| the edit changed nothing | 8 |
| the call was malformed | 8 |
| the file doesn't exist | 3 |
| reason unknown | 1 |

## The graveyard

The figures that removed each detector, over the same 1,139 sessions. The full record is in
[`GRAVEYARD.md`](https://github.com/vibesenpai/vibesenpai/blob/main/GRAVEYARD.md).

| detector | figure |
|---|---|
| `stale_read` | matched 27.7% of sessions; all 2,078 candidates followed the agent's own earlier edit |
| `permission_denied` | 18.1% of sessions had one; the denials were `ExitPlanMode` and `AskUserQuestion` |
| `inaccurate_self_report` as a free check | 0 true positives, 5 false positives |
| `file_churn` | 48% of sessions edit some file five or more times, 23% ten or more; more than five versions in Claude Code's file history matches 11% |
| `reading_spiral` | matched 51% of sessions; parallel subagents explained 4 of 2,182 matches; 15 repeated reads were the same call and 2,167 were different |
| three text-reading detectors | 5 true positives against about 25 false positives |
