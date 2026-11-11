---
title: Install and update
description: Two commands in Claude Code, what happens the first time, and how to update or turn it off.
---

How to install the plugin, what happens after you do, and how to update it or turn it off.

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
- **Claude Code 2.1.299 or later.** The pane needs it. On an older version, `/vibesenpai:insights`
  says which version it needs and which one is running, and `claude update` installs the latest.

## What happens the first time

When your next session starts, a one-time notice says what the model reads will do:

```
vibesenpai is on. Starting when this turn ends, it reads your sessions in the background
with Claude Haiku on your plan or API key: up to 200 recent past sessions first,
then each new one, at most 2.0M tokens a day.
Nothing has been spent yet.
```

It then lists three commands:

- `/vibesenpai:insights` shows what it has found.
- `/vibesenpai:judge off` stops the model reads. The free checks keep running.
- `/plugin disable vibesenpai` stops everything.

On an API key, Bedrock or Vertex, it says "on your API key" instead of "on your plan or API key".
The notice is shown once.

After that, three things happen on their own:

- **The history pass** runs the free checks in the background, at most every 10 minutes. The
  hooks start it when a session starts and when a turn ends. It spends nothing.
- **The model reads** start when a turn ends. They read up to 200 of your most recent past
  sessions first, then each new session as it grows, within about 2M tokens a day.
- **The pane** shows what has been found so far when you open it with
  [`/vibesenpai:insights`](/vibesenpai/commands/insights/). It fills in as the history pass and
  the model reads finish.

What is sent to the model, and what it costs, is on
[What leaves your machine](/vibesenpai/start/sends-and-costs/).

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
| `~/.local/share/vibesenpai` (or `$XDG_DATA_HOME/vibesenpai`) | its own store: findings, your answers, settings, reports |
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
