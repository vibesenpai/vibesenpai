---
title: Reference
description: Four commands and every setting, in one place.
---

## Commands

Typed in Claude Code, once the plugin is installed.

| | |
|---|---|
| `/agentsensei:insights` | What happened in the session you are in. Renders instantly from what has already been analysed, then reads this session with the model. |
| `/agentsensei:fix` | A recommendation, with the evidence for it — or a plain statement that no fix exists. |
| `/agentsensei:report` | Writes a self-contained HTML report of your history and prints the path. No JavaScript, no external resources, mode 0600. |
| `/agentsensei:dismiss` | Sets findings aside. With no arguments it lists them and asks which, and whether each is wrong or just not worth showing. `all` clears everything shown so far, and new findings still appear. `undo <id>` or `undo all` restores them. Nothing is deleted. |

`/plugin disable agentsensei` turns everything off.

## Settings

Environment variables, read at startup. None of them are required.

| variable | effect |
|---|---|
| `AGENTSENSEI_DISABLE=1` | Stops everything, including the hooks, immediately. Checked on the first line of every entry point |
| `AGENTSENSEI_ARCHIVE` | Where the store lives. Default `~/.local/share/agentsensei` |
| `AGENTSENSEI_SOURCES` | Where transcripts are read from, comma-separated. Default `~/.claude/projects` |
| `AGENTSENSEI_CONFIG` | Path to a config file |
| `AGENTSENSEI_PRESET` | `core` (default) or `standard`. See below |
| `AGENTSENSEI_MUTE` | Dimensions to silence, comma-separated |
| `AGENTSENSEI_COLOR` | `1` forces ANSI on, `0` forces it off. Otherwise colour follows `NO_COLOR` and whether output is a terminal |

A config file may set `archive`, `sources`, `preset` and `mute`. Precedence is
flag → environment → file → platform default, and a value that is rejected is
reported as a warning rather than silently ignored.

### Presets

| preset | detectors |
|---|---|
| `core` *(default)* | `edit_retry` |
| `standard` | `edit_retry`, `redundant_call` |
| `all` | the same as `standard` today — there is nothing beyond it yet |

The default is one detector, which is deliberate — `redundant_call` is real but
has no fix, so it reports rather than helps. The judge's five dimensions are
independent of the preset.
[What each one looks for →](/agentsensei/findings/dimensions/)

## Where things live

| path | what |
|---|---|
| `~/.claude/projects/**` | **read in place.** Never modified, never copied |
| `~/.local/share/agentsensei/index.json` | byte offsets and hashes of what has been read |
| `~/.local/share/agentsensei/standing.json` | findings across your history |
| `~/.local/share/agentsensei/judge.json` | judge settings, the ledger, and findings |
| `~/.local/share/agentsensei/reports/` | HTML reports, mode 0600 |

Losing any of them costs a re-scan and nothing else — everything is derived
from transcripts we do not own.

## The CLI

There is one, and it is what the plugin's hooks and slash commands invoke. It
is not published to npm and is not meant to be typed by hand. If you are
working on agentsensei itself, [Contribute](/agentsensei/contribute/) has it.
