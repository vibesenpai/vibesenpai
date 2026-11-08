---
title: Install
description: One command in Claude Code. There is nothing else to set up.
---

```
/plugin marketplace add vibesenpai/vibesenpai
/plugin install vibesenpai@vibesenpai
```

That is the whole thing. No npm, no clone, nothing to bootstrap — vibesenpai
ships with **zero runtime dependencies**, and Node is already on your machine
because Claude Code requires it.

To update to a new release: `/plugin`, then **Installed**, vibesenpai, **Update now**; or
`claude plugin update vibesenpai@vibesenpai` from a terminal. Updates are not automatic for
marketplaces outside Anthropic's own unless you turn auto-update on under **Marketplaces**.

:::caution[Not published yet]
The marketplace entry is built and the plugin runs from a clone, but it has not
been exercised through a real `/plugin install`. Until it has,
[Contribute](/vibesenpai/contribute/) has the from-source path.
:::

## What you get

Three commands:

| | |
|---|---|
| `/vibesenpai:insights` | what happened in the session you are in |
| `/vibesenpai:judge` | model reads on or off |
| `/vibesenpai:report` | a self-contained HTML report of your history |

And two hooks, which keep your history indexed in the background. Both are
local and cost nothing — see [Phases of a run](/vibesenpai/architecture/phases/).

## What it does on first run

It reads the transcripts Claude Code already writes to `~/.claude/projects`.
Nothing is copied:

```
scanned 16 transcripts · 16 new, 0 grown, 0 unchanged
read 55.7 MB · copied nothing
catalog · 16 sessions · ~/.local/share/vibesenpai
```

The first time you run `/vibesenpai:insights`, it will also read that session with
the model on your own account and tell you it is doing so. That is the judge,
it is on from installation, and
[what it sends and what it costs](/vibesenpai/start/sends-and-costs/) is a page
of its own because you should not have to go looking for it.

## Where it keeps things

| path | what |
|---|---|
| `~/.claude/projects/**` | **read in place.** Never modified, never copied |
| `~/.local/share/vibesenpai` | its own store: the catalog, findings, reports |
| `~/.claude/settings.json` | untouched — the plugin carries its own hooks |

Override the store with `VIBESENPAI_ARCHIVE`, and the transcript sources with
`VIBESENPAI_SOURCES`.

## Turning it off

```
/plugin disable vibesenpai
```

Harness-native, and it stops everything — hooks included.
[What it sends, and what it costs](/vibesenpai/start/sends-and-costs/) has the
rest, including why there is no "keep the rules, stop the model" switch.
