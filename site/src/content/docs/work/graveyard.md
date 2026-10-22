---
title: The graveyard
description: Ten detectors built, measured, and deleted — with the evidence that killed each one.
---

Ten detectors were built here, measured against real sessions, and deleted.
This page exists because a tool that tells you what your agent got wrong should
be able to say what it got wrong itself.

The full record is in [`GRAVEYARD.md`](https://github.com/crozzfire/agentsensei/blob/main/GRAVEYARD.md).
These are the ones worth reading.

## `stale_read` — 100% explained by something innocent

The idea: the agent reads a file, something changes it, the agent acts on the
stale copy.

Measured on real sessions, **every single candidate** was explained by the
agent's own prior edit. It had changed the file itself, so of course the read
was stale. There was no case left over where something external had moved
underneath it.

A detector whose entire population has an innocent explanation is not a
detector with a precision problem. It is a detector with no subject.

## `permission_denied` — the denials were people working normally

18.1% of sessions had a denied tool call, which looked like a lot.

Then: of **398 denials, only 6 were re-issued** after the guard. People decline
things and move on. That is a person exercising control over their own machine,
which is the system working rather than failing.

We could have shipped a finding that fired on one in five sessions. It would
have been telling people off for saying no.

## `inaccurate_self_report` as a rule — 0 true positives, 5 false

This one is instructive because the dimension is real and the *approach* was
wrong.

Built on structure — look for a success claim near a failed tool result — it
produced **zero true positives and five false positives**. Every one of the five
was an agent honestly describing partial progress.

It works now, and it is one of the better dimensions, because [the judge](/agentsensei/start/the-judge)
reads what was actually said instead of pattern-matching around it. Same
dimension, different tier, opposite outcome.

## `file_churn` — real, frequent, and not established as waste

A file going through many versions in one session: present in **48% of
sessions**.

The problem was never detection. It was that nobody could show churn is waste.
Iterating is how the work gets done. A finding that fires on half of all
sessions and cannot say whether the thing it found was bad is a number, not an
insight.

## `reading_spiral` — killed by the wrong reason, then by the right one

Documented as confounded by sidechains. When that was finally measured, the
sidechain confound was **4 of 2,182 cases — 0%**. The documented reason was
wrong.

The real reason killed it anyway: 99% of the repeated reads were different
calls, not the same call repeated. The detector was counting normal exploration.

Worth keeping because the first explanation was confidently wrong and nobody
checked for weeks.

## The method failures, which are the uncomfortable half

Detectors failing is ordinary. These are mistakes in how things were measured,
and they are here because they are more useful than the successes.

### A result buried as a failure that was worth +11 points

A change to the judge's rubric was measured, found to make things worse, and
written up as a dead end. It was measured on 60 of 246 available sessions,
against a baseline that had been **edited partway through the experiment**.

On the full set it is worth **+11 points of session-level agreement**. It had
been working the whole time.

### A "16-point variance band" that was a code change

Three runs of what was believed to be identical code scored 52%, 66% and 67%.
That was written up as evidence that the judge's output is wildly unstable, and
a recommendation to run every experiment three times.

`src/judge.ts` had been rewritten **during the experiment**. Run 1 read the old
prompt; runs 2 and 3 read the new one. True same-code variance is run 2 against
run 3: **66% versus 67%**.

The fix was not "be more careful". A scoring run now records the commit it ran
against, so a mid-experiment edit is self-evident rather than something someone
has to notice.

### Sampling 60 of 246 sessions for a dozen runs

Nobody decided this. An early run picked 60 for cost, and every later run
inherited it, so an entire measurement campaign ran at roughly twice the error
bar it needed to — on data that was sitting on the same disk the whole time.

Scoring now defaults to every labelled session. Sampling is something you ask
for.

## Why publish this

Three reasons, in increasing order of honesty.

It stops the same ideas being rebuilt. Every entry has the number that killed
it, so "what about detecting file churn?" has an answer.

It is the only evidence that the dimensions which *did* ship were not simply
the first ten things someone thought of.

And a tool whose entire premise is *"here is where your agent went wrong, with
the evidence"* has no standing to be shy about its own. If this page did not
exist, you would be right to wonder what was in it.
