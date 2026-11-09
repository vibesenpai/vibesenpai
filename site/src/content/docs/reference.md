---
title: Reference
description: The three commands, every setting, and every file it keeps, with what losing each one costs.
---

## Commands

| | |
|---|---|
| [`/vibesenpai:insights`](/vibesenpai/commands/insights/) | opens the pane: findings, fixes with Apply, and the background jobs' health |
| [`/vibesenpai:judge`](/vibesenpai/commands/judge/) | `on` or `off` for the model reads; with no argument, their status |
| [`/vibesenpai:report`](/vibesenpai/commands/report/) | writes your history as one HTML file and opens it |

`/plugin disable vibesenpai` stops everything, hooks included.

## Settings

None are required. Each is resolved in this order: a CLI flag, then an environment variable,
then the config file, then the default. A `preset` that is not one of the three, or a `mute`
name that is not a free check, is reported as a warning, never silently ignored.

The flags belong to the CLI the plugin runs; the slash commands take none. To change a setting,
use the config file, or the environment Claude Code runs in.

| setting | flag | environment | config file key | default |
|---|---|---|---|---|
| transcript sources | `--source` (repeatable) | `VIBESENPAI_SOURCES`, separated by `,` or `:` | `sources` (a list) | `~/.claude/projects` and `~/.codex/sessions` |
| store location | `--archive` | `VIBESENPAI_ARCHIVE` | `archive` | `$XDG_DATA_HOME/vibesenpai`, else `~/.local/share/vibesenpai` |
| free-check preset | `--preset` | `VIBESENPAI_PRESET` | `preset` | `core` |
| muted free checks | `--mute` (repeatable) | `VIBESENPAI_MUTE`, separated by `,` or `:` | `mute` (a list) | none |
| config file | `--config` | `VIBESENPAI_CONFIG` | | `$XDG_CONFIG_HOME/vibesenpai/config.json`, else `~/.config/vibesenpai/config.json` |

Only Claude Code transcripts are parsed; the second default source has no parser yet.

`mute` takes the names of free checks (`edit_retry`, `redundant_call`). A muted check is not
computed, counted or mentioned. A name that is not a free check is reported as unknown.

A config file is JSON:

```json
{ "preset": "standard", "mute": ["redundant_call"] }
```

### Environment only

| variable | effect |
|---|---|
| `VIBESENPAI_DISABLE=1` | every hook returns on its first line. Nothing runs |
| `VIBESENPAI_COLOR` | `1` forces colour in text output, `0` turns it off |
| `NO_COLOR` | turns colour off, unless `VIBESENPAI_COLOR=1` |

Without either, colour follows whether the output is a terminal.

### Presets

A preset decides which free checks run. It does not affect the model reads, which read for
their own kinds whatever the preset.

| check | `core` (default) | `standard` | `all` |
|---|---|---|---|
| [Edit retry](/vibesenpai/dimensions/edit-retry/) (`edit_retry`) | yes | yes | yes |
| [Repeated call](/vibesenpai/dimensions/redundant-call/) (`redundant_call`) | | yes | yes |

`all` is the same as `standard` today. [Cache rebuilds](/vibesenpai/dimensions/cache-rebuilds/)
are not a preset check; they are shown whenever one happened.

### Model-read settings

Kept in `judge-settings.json` in the store. The file exists once a setting has been written;
until then the defaults apply. `/vibesenpai:judge on|off` sets `enabled`; the rest have no
slash command.

| key | default | what |
|---|---|---|
| `enabled` | `true` | whether the model reads run |
| `model` | `haiku` | the model passed to `claude -p --model` |
| `dailyTokens` | `2000000` | tokens, in and out, the automatic reads may use per local day |
| `catchUp` | `200` | never-read past sessions read once, newest first |
| `cadence` | `50` | turns of new transcript before a live session is read again |
| `maxBatchTokens` | `60000` | a batch larger than this is split |
| `concurrency` | `3` | batches sent at once |
| `lookback` | `true` | a misread or a broken constraint must cite where the expectation was set before the agent acted |

## Files

Everything lives under the store, `~/.local/share/vibesenpai` by default. Transcripts are
never copied into it; they are read in place under `~/.claude/projects`.

| file | holds | losing it costs |
|---|---|---|
| `store.db` | model findings and their quotes; how far each session has been read; tokens and dollars spent; your answers (hidden, wrong, not the agent's fault); when each fix was requested and when its rule was first seen loaded; the catch-up cutoff | **the most.** Model findings come back only by reading again, which spends tokens again, and only for transcripts Claude Code still keeps. The 200-session catch-up starts over, and today's token count starts from zero. Hidden and wrong findings reappear and count again. Fix history comes back only from transcripts still kept |
| `standing.json` | your history from the free checks | nothing: the next history pass recomputes it |
| `finding-fixes.json` | each model finding's own fix | nothing: the next history pass recomputes it; until then each kind's fix shows |
| `judge-settings.json` | the model-read settings above | the defaults return, **including `enabled: true`**: model reads you turned off come back on |
| `disclosed` | that the one-time notice was shown | the notice is shown again |
| `last-session-start` | when the last session started | the next session start shows no "new since your last session" count |
| `jobs/` | each background job's last run, failures, back-off and hold | the record starts afresh; a model-read hold after paid failures is released |
| `reports/` | the HTML reports you wrote | those files |
| `index.json` | a transcript index, written only by a maintenance command of the CLI | nothing |

Claude Code keeps transcripts for a limited time and nothing here is a copy of one, so there
is no history beyond what Claude Code still keeps.

The JSON files and reports are written to a temporary name and renamed, so a crash leaves the
old version whole.
