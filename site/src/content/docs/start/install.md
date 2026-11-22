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

That is all. There is nothing to configure. The plugin brings its own hooks and commands, and
vibesenpai never writes your `~/.claude/settings.json`.

### From a terminal

```
npx vibesenpai install
```

It checks for Node 22.13+ and Claude Code 2.1.299+, shows the one command it will run, and asks
before running it:

```
claude plugin install vibesenpai --marketplace vibesenpai/vibesenpai
```

That is Claude Code's own installer: it adds the marketplace and installs the plugin. The npm
package has no install script, no dependencies and no network calls of its own, and writes no
files. `--scope user|project|local` picks where Claude Code installs it (default: user). With no
terminal attached, such as in a script, add `--yes` or run that command yourself.

## Requirements

- **Node 22.13 or later.** The plugin runs TypeScript directly, with no build step.
- **Claude Code 2.1.299 or later.** The pane needs it. On an older version, `/vibesenpai:insights`
  says which version it needs and which one is running, and `claude update` installs the latest.

## What happens the first time

When your next session starts, the free checks begin, and a one-time notice says the model
reads are paused:

```
vibesenpai is running its free checks. Its model reads are paused, and nothing has been sent.
Turned on, they read your sessions with Claude Haiku on your plan or API key after each turn ends:
up to 200 recent past sessions first, then each new one, at most 2.0M tokens a day.
/vibesenpai:insights shows exactly what they would send, and turns them on if you say yes.
```

Nothing is sent until you look at what would be sent and press **Turn on**.
[How your data is used](/vibesenpai/start/sends-and-costs/) describes what that means.

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
[How your data is used](/vibesenpai/start/sends-and-costs/).

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
