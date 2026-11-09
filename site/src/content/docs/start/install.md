---
title: Install and update
description: Two commands in Claude Code, what happens the first time, and how to update or turn it off.
---

:::caution[Not published yet]
No release has been published. The marketplace entry is built and the plugin runs from a
clone, but it has not been exercised through a real `/plugin install`. Until it has,
[Contribute](/vibesenpai/contribute/) has the from-source path.
:::

## Install

In Claude Code:

```
/plugin marketplace add vibesenpai/vibesenpai
/plugin install vibesenpai@vibesenpai
```

On Claude Code 2.1.275 or later, one step does both:

```
/plugin install vibesenpai --marketplace vibesenpai/vibesenpai
```

There is nothing else to set up and nothing to install from npm. The plugin carries its own
hooks and commands; your `~/.claude/settings.json` is not touched.

## Requirements

| | |
|---|---|
| **Node** | 22.13 or later. The plugin runs TypeScript directly, with no build step and no runtime dependencies |
| **Claude Code** | A release ships as a zip on a tagged GitHub release ([D69](/vibesenpai/architecture/decisions/)). Claude Code added that kind of marketplace source in 2.1.224; what older versions do with it has not been tested |
| **Harness** | Claude Code only |

## The first time

At the start of a session, a one-time notice says what the model reads will do:

```
vibesenpai is on. Starting when this turn ends, it reads your sessions in the background
with Claude Haiku on your plan or API key: up to 200 recent past sessions first,
then each new one, about 60k tokens a session and at most 2.0M tokens a day.
Nothing has been spent yet.
```

It then lists three commands: `/vibesenpai:insights` (what it has found),
`/vibesenpai:judge off` (stop the model reads; the free checks keep running) and
`/plugin disable vibesenpai` (stop everything). On an API key, Bedrock or Vertex it says
"on your API key" instead of "on your plan or API key".

It is shown once per machine. After that:

- **The free checks** run in the background, started by the hooks at session start and when
  a turn ends, at most every 10 minutes. They read transcripts in place and spend nothing.
- **The model reads** start when a turn ends: up to 200 of your most recent past sessions
  first, then each new session as it grows, within 2M tokens a day.
  [`/vibesenpai:judge`](/vibesenpai/commands/judge/) has the limits and the off switch.
- **The pane** opens with [`/vibesenpai:insights`](/vibesenpai/commands/insights/). It
  shows what has been found so far and fills in as the background passes finish.

What is sent to the model, and what it costs, is on
[What it sends, and what it costs](/vibesenpai/start/sends-and-costs/).

## Update

In Claude Code: `/plugin`, then **Installed**, **vibesenpai**, **Update now**. From a
terminal:

```
claude plugin update vibesenpai@vibesenpai
```

Claude Code does not auto-update plugins from marketplaces outside Anthropic's own unless you
turn auto-update on for that marketplace under **Marketplaces**.

## Where it keeps things

| path | what |
|---|---|
| `~/.claude/projects/` | Claude Code's transcripts. **Read in place**, never modified, never copied |
| `~/.local/share/vibesenpai` | its own store: findings, your answers, settings, reports |
| `~/.claude/settings.json` | never written |

Every file in the store, and what losing it costs, is listed in
[Reference](/vibesenpai/reference/#files).

## Turning it off

| | |
|---|---|
| `/vibesenpai:judge off` | stops the model reads. The free checks keep running |
| `/plugin disable vibesenpai` | stops everything, hooks included |
| `VIBESENPAI_DISABLE=1` | in the environment Claude Code runs in, stops every hook on its first line |

Disabling keeps the store. Deleting `~/.local/share/vibesenpai` removes everything it has
written.
