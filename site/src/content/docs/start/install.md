---
title: Install
description: Two ways in — as a Claude Code plugin, or as a CLI.
---

:::caution[Not published yet]
`agentsensei` is not on npm or the plugin marketplace yet, so the first two
sections below describe installs that are **built and tested but not yet
reachable** — they start working the day this is published. Until then,
[from source](#from-source) is the one that works.
:::

## As a Claude Code plugin

```
/plugin marketplace add crozzfire/agentsensei
/plugin install agentsensei
```

This gives you `/agentsensei:now`, `/agentsensei:fix` and
`/agentsensei:generate-report` inside Claude Code, plus the hooks that keep your
history indexed in the background.

## As a CLI

```bash
npm install -g agentsensei
```

Then three commands, in this order:

```bash
agentsensei scan                # index your transcripts — copies nothing
agentsensei standing --refresh  # compute findings across your history
agentsensei fix                 # the one thing worth changing
```

What the first one prints:

```
scanned 16 transcripts · 16 new, 0 grown, 0 unchanged
read 55.7 MB · copied nothing
catalog · 16 sessions · ~/.local/share/agentsensei
```

The order matters: `fix` reads what `standing` computes, and will tell you so if
you skip it. All three finish in about a second on a few hundred sessions —
there is no long indexing phase to wait through.

## From source

```bash
git clone https://github.com/crozzfire/agentsensei && cd agentsensei
npm install
npm run cli -- now       # or: npm run build && npm link, for `agentsensei` on PATH
```

Node 22.13 or later. Zero runtime dependencies — `npm install` is pulling test
and build tooling only.

## Where it keeps things

| path | what |
|---|---|
| `~/.claude/projects/**` | **read in place.** Never modified, never copied |
| `~/.local/share/agentsensei` | its own store: the catalog, findings, reports |
| `~/.claude/settings.json` | **only** via `agentsensei install`, which prints the change and needs `--apply` |

Override the store with `AGENTSENSEI_ARCHIVE`, and the transcript sources with
`AGENTSENSEI_SOURCES`.

## Turning it off

```bash
AGENTSENSEI_DISABLE=1          # stops everything, including hooks, immediately
agentsensei uninstall          # removes the hooks it added
```

The first one is a hard kill switch that every entry point checks on its first
line. If you are trying this on a work machine, that is the thing to know.
