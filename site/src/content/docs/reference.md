---
title: Reference
description: The three commands, every setting, and every file it keeps, with what losing each one costs.
---

Everything you can set, and every file the plugin keeps, in one place.

## Commands

| | |
|---|---|
| [`/vibesenpai:insights`](/vibesenpai/commands/insights/) | opens the pane: findings, fixes with Apply, and the background jobs' health |
| [`/vibesenpai:judge`](/vibesenpai/commands/judge/) | `on` or `off` for the model reads; with no argument, their status |
| [`/vibesenpai:report`](/vibesenpai/commands/report/) | writes your history as one HTML file and opens it |

`/plugin disable vibesenpai` stops everything, hooks included.

## Settings

None are required. The slash commands take no settings, so set them in the config file or in
the environment Claude Code runs in.

If a setting is given in more than one place, the first of these wins: a CLI flag, an
environment variable, the config file, the default. (The flags belong to the CLI the plugin runs.)

| setting | environment | config file key | default |
|---|---|---|---|
| transcript sources | `VIBESENPAI_SOURCES`, separated by `,` or `:` | `sources` (a list) | `~/.claude/projects` and `~/.codex/sessions` |
| store location | `VIBESENPAI_ARCHIVE` | `archive` | `$XDG_DATA_HOME/vibesenpai`, else `~/.local/share/vibesenpai` |
| free-check preset | `VIBESENPAI_PRESET` | `preset` | `core` |
| muted free checks | `VIBESENPAI_MUTE`, separated by `,` or `:` | `mute` (a list) | none |
| config file | `VIBESENPAI_CONFIG` | | `$XDG_CONFIG_HOME/vibesenpai/config.json`, else `~/.config/vibesenpai/config.json` |

The matching flags are `--source` (repeatable), `--archive`, `--preset`, `--mute` (repeatable)
and `--config`.

Only Claude Code transcripts are read; the second default source has no parser yet.

The config file is JSON:

```json
{ "preset": "standard", "mute": ["redundant_call"] }
```

An unknown `preset`, or a `mute` name that is not a free check, is reported as a warning. It is
never silently ignored.

### Presets and mute

A preset decides which free checks run. It does not affect the model reads.

| check | `core` (default) | `standard` | `all` |
|---|---|---|---|
| [Edit retry](/vibesenpai/dimensions/edit-retry/) (`edit_retry`) | yes | yes | yes |
| [Repeated call](/vibesenpai/dimensions/redundant-call/) (`redundant_call`) | | yes | yes |

`all` is the same as `standard` today. [Cache rebuilds](/vibesenpai/dimensions/cache-rebuilds/)
are not part of a preset; they are shown whenever one happened.

`mute` takes free-check names (`edit_retry`, `redundant_call`). A muted check is not computed,
counted or mentioned.

### Environment only

| variable | effect |
|---|---|
| `VIBESENPAI_DISABLE=1` | every hook returns before doing anything. Nothing runs |
| `VIBESENPAI_COLOR` | `1` forces colour in text output, `0` turns it off |
| `NO_COLOR` | turns colour off, unless `VIBESENPAI_COLOR=1` |

Without either, colour is on only when the output is a terminal.

### Model-read settings

Kept in `judge-settings.json` in the store. Until a setting has been written, the defaults
apply. `/vibesenpai:judge on` and `off` set `enabled`; the others have no slash command.

| key | default | what |
|---|---|---|
| `enabled` | `true` | whether the model reads run |
| `model` | `haiku` | the model passed to `claude -p --model` |
| `dailyTokens` | `2000000` | tokens, in and out, the automatic reads may use per local day |
| `catchUp` | `200` | past sessions read once, newest first |
| `cadence` | `50` | new turns before a live session is read again |
| `maxBatchTokens` | `60000` | a batch larger than this is split |
| `concurrency` | `3` | batches sent at once |
| `lookback` | `true` | a misread or a broken constraint must cite where the expectation was set before the agent acted |

## Files

Everything lives in the store, `~/.local/share/vibesenpai` by default. Transcripts are never
copied into it; they are read where Claude Code keeps them, under `~/.claude/projects`.

| file | holds | if you delete it |
|---|---|---|
| `store.db` | model findings and their quotes; how far each session has been read; tokens and dollars spent; your answers; when each fix was requested and first seen loaded | **you lose the most.** Model findings come back only by reading again, which spends tokens again, and only for transcripts Claude Code still keeps. The 200-session catch-up starts over. Hidden findings reappear. Fix history comes back only from transcripts still kept |
| `standing.json` | your history from the free checks | nothing: the next history pass rebuilds it |
| `finding-fixes.json` | each model finding's own fix | nothing: the next history pass rebuilds it |
| `judge-settings.json` | the model-read settings above | the defaults return, **including `enabled: true`**: model reads you turned off come back on |
| `disclosed` | that the one-time notice was shown | the notice is shown again |
| `last-session-start` | when the last session started | the next session start shows no "new since your last session" count |
| `jobs/` | each background job's last run, failures and hold | the record starts fresh; a hold on the model reads is released |
| `reports/` | the HTML reports you wrote | those files |
| `index.json` | a transcript index, written only by a maintenance command | nothing |

Claude Code deletes old transcripts after a while, and nothing here is a copy of one. So there
is no history beyond what Claude Code still keeps.

The JSON files and reports are written to a temporary name and then renamed, so a crash leaves the old version whole.
