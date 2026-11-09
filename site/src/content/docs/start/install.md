---
title: Install and update
description: Two commands in Claude Code, what happens the first time, and how to update or turn it off.
---

How to install the plugin, what happens after you do, and how to update it or turn it off.

:::caution[Not published yet]
No release has been published. The plugin runs from a clone, but it has not been tested
through a real `/plugin install`. Until it has, [Contribute](/vibesenpai/contribute/) has the
from-source path.
:::

## Install

In Claude Code:

```
/plugin marketplace add vibesenpai/vibesenpai
/plugin install vibesenpai@vibesenpai
```

That is all. There is nothing to install from npm and nothing to configure. The plugin brings its
own hooks and commands, and your `~/.claude/settings.json` is not touched.

## Requirements

- **Node 22.13 or later.** The plugin runs TypeScript directly, with no build step.
- **Claude Code.** A release ships as a zip on a GitHub release. Claude Code added support for
  that kind of marketplace source in 2.1.224; older versions have not been tested.

## What happens the first time

When your next session starts, a one-time notice says what the model reads will do:

```
vibesenpai is on. Starting when this turn ends, it reads your sessions in the background
with Claude Haiku on your plan or API key: up to 200 recent past sessions first,
then each new one, about 60k tokens a session and at most 2.0M tokens a day.
Nothing has been spent yet.
```

It then lists three commands:

- `/vibesenpai:insights` shows what it has found.
- `/vibesenpai:judge off` stops the model reads. The free checks keep running.
- `/plugin disable vibesenpai` stops everything.

On an API key, Bedrock or Vertex, it says "on your API key" instead of "on your plan or API key".
The notice is shown once.

After that, three things happen on their own:

- **The free checks** run in the background, at most every 10 minutes. They are started by
  the hooks when a session starts and when a turn ends. They spend nothing.
- **The model reads** start when a turn ends. They read up to 200 of your most recent past
  sessions first, then each new session as it grows, within 2M tokens a day.
- **The pane** shows what has been found so far when you open it with
  [`/vibesenpai:insights`](/vibesenpai/commands/insights/). It fills in as the background
  passes finish.

What is sent to the model, and what it costs, is on
[What it sends, and what it costs](/vibesenpai/start/sends-and-costs/).

## Update

In Claude Code, run `/plugin`, then choose **Installed**, **vibesenpai**, **Update now**. Or,
from a terminal:

```
claude plugin update vibesenpai@vibesenpai
```

Claude Code does not auto-update plugins from marketplaces outside Anthropic's own. To change
that, turn on auto-update for this marketplace under **Marketplaces**.

## Where it keeps things

| path | what |
|---|---|
| `~/.claude/projects/` | Claude Code's transcripts. Read in place; never changed, never copied |
| `~/.local/share/vibesenpai` | its own store: findings, your answers, settings, reports |
| `~/.claude/settings.json` | never written |

Every file in the store is listed in [Reference](/vibesenpai/reference/#files).

## Turning it off

| | |
|---|---|
| `/vibesenpai:judge off` | stops the model reads. The free checks keep running |
| `/plugin disable vibesenpai` | stops everything, hooks included |
| `VIBESENPAI_DISABLE=1` | set in the environment Claude Code runs in, stops every hook before it does anything |

Disabling keeps the store. To remove everything it has written, delete
`~/.local/share/vibesenpai`.
