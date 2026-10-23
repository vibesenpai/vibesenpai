---
title: What else is out there
description: Claude Code already ships a session analyzer. Here is what survives the comparison, and what does not.
---

**Claude Code already has `/insights`.** It is free, first-party, already
installed, and it does something close to this. Any honest page about
agentsensei has to start there.

## `/insights`

Per Anthropic's own documentation, it *"analyzes your recent sessions on this
machine and writes an HTML report covering what you work on, **friction points
such as misunderstood requests or buggy code**, and suggestions for using
Claude Code more effectively."*

Up to 200 sessions per run. Runs on any plan. The tokens count against your
usage. "Friction points such as misunderstood requests" is our
`misread_intent`, by another name.

So: if you want a narrative read on how your sessions are going, type
`/insights` and skip this project. It costs you nothing extra and it is
maintained by the people who build the harness.

**Two things survive the comparison**, and neither of them is "we are local":

**Its findings are model-authored narrative with nothing to check them
against.** It reads your sessions and writes prose about them. Every finding
here quotes the turn it came from, so you can open the transcript and disagree.
That is the difference between a report and evidence.

**It publishes no accuracy figure.** Neither does anyone else in this space. We
publish [165 of 232](/agentsensei/work/measuring/) and call it *silver
agreement* rather than precision, because the labels we agree with were
themselves model-produced.

## The rest of the field

| | what it is | how it differs |
|---|---|---|
| **vibe-log** | the closest third-party competitor — standup summaries, a prompt-quality score, coaching, hooks | Scores you (`85/100`) without showing the turns. Optional cloud sync is a new party; we add none |
| **session-report** | Anthropic's bundled analyzer: tokens, cache breaks, by-project breakdowns | Measures **spend**, not habits — 44 token references in its script and zero for rework, loops or corrections |
| **claude-code-history-viewer** | an offline browser over 11 harnesses' histories | A viewer. No diagnosis, and no opinion about what went wrong |
| **agent-loop-detector** | a runtime guardrail that catches cyclic tool calls live | Prevention in-flight rather than retrospective evidence. A different problem |

## Two claims we retired

This project started with six differentiators. Two did not survive contact with
the field, and the honest thing is to say which:

**"Fully local" is not a differentiator.** vibe-log is local-first too; its
cloud sync is opt-in. This is table stakes in this ecosystem, not an edge — and
since the judge runs through your own harness, [it is no longer even strictly
true of us](/agentsensei/start/sends-and-costs/).

**"Cross-harness" is not a differentiator.** The history viewer covers eleven
harnesses. We cover **one**, and the parser registry that is supposed to make
more possible has exactly one parser in it. We would be starting at 1.

What is left is narrower and defensible: **evidence instead of scores**,
**measured accuracy published with the right word on it**, and **no new party
sees your data**. That is the whole claim.
