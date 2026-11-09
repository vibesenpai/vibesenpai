---
title: What else is out there
description: How this tool compares with Claude Code's /insights and other session tools.
---

This page compares vibesenpai with other tools that read coding-agent sessions.
Tool details were checked against each project's docs and repository on
2026-10-12
([docs/prior-art.md](https://github.com/vibesenpai/vibesenpai/blob/main/docs/prior-art.md)).

## Claude Code's `/insights`

Claude Code ships `/insights`. Anthropic's documentation says it *"analyzes
your recent sessions on this machine and writes an HTML report covering what you
work on, friction points such as misunderstood requests or buggy code, and
suggestions for using Claude Code more effectively."*

- It reads up to 200 sessions per run.
- It runs on any plan, and its tokens count against your usage.
- "Misunderstood requests" overlaps with vibesenpai's
  [Misread intent](/vibesenpai/dimensions/misread-intent/).

Two differences:

| | `/insights` | vibesenpai |
|---|---|---|
| a finding is | model-written prose about your sessions | a quote from a specific turn you can open |
| accuracy | none published | checked against a labelled research set ([How it was measured](/vibesenpai/architecture/measurements/)) |

## Other tools

| tool | what it is | how it differs |
|---|---|---|
| [vibe-log-cli](https://github.com/vibe-log/vibe-log-cli) | standup summaries, a prompt-quality score, coaching, hooks; optional cloud sync | shows a score (`85/100`) without the turns behind it |
| `session-report`, in Anthropic's official plugin marketplace | Anthropic's session analyzer: tokens, cache breaks, per-project breakdowns | measures spend; its script has no measure of rework, loops or corrections |
| [claude-code-history-viewer](https://github.com/jhlee0409/claude-code-history-viewer) | an offline browser over 11 harnesses' histories | a viewer, with no diagnosis |
| [agent-loop-detector](https://github.com/Princeu3/agent-loop-detector) | a runtime guard that catches repeated tool calls live | prevents during a session; does not report afterwards |

## What is not a difference

- **Running locally.** vibe-log is local-first too, and the judge here
  sends session content to a model
  ([What leaves your machine](/vibesenpai/start/sends-and-costs/)).
- **Covering many harnesses.** The history viewer covers 11; this tool covers
  one.

What remains: findings are quotes from turns rather than scores, an accuracy
figure is published, with its method, and no new party sees your data.
