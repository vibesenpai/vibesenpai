---
title: /vibesenpai:insights
description: Opens the pane beside the chat, with what has been found, the fixes, and the background jobs' health.
---

```
/vibesenpai:insights
```

Opens the insights pane beside the chat. It takes no arguments.

## What it does

It reads what the background passes have already worked out (the free checks, the model
reads, the fixes) and shows it. It never sends anything to a model and never spends tokens:
the model reads run only from the `Stop` hook, when a turn ends.

When the pane opens, Claude Code prints `Insights opened beside the chat.` The pane itself is
described on [A tour of the pane](/vibesenpai/start/pane/): the Findings, Fixes and Health
tabs, Apply, and the answers you can give a finding.

The pane stays open and refreshes itself when a background pass writes something new.

## Where no pane can open

Where Claude Code cannot place a pane, the command prints a text version instead: the
session you are in, read live with the free checks plus any model findings already stored
for it, then your history, then how far the model reads have got. From the demo data:

```
  This session · 0 edits

  Your history

    11 edits were rejected and retried, across 7 files
       most often tokenizer.js
    3 misread intent
    5 inaccurate self report
    1 other

  The cache was rebuilt from scratch 30 times — 1.4M tokens written again

  Analysis

    101 of 101 sessions read
    Up to date.

  Run /vibesenpai:report for more details
```

The text version has no Apply and no answers; those are in the pane.

## Related

| | |
|---|---|
| [`/vibesenpai:judge`](/vibesenpai/commands/judge/) | turns the model reads on or off |
| [`/vibesenpai:report`](/vibesenpai/commands/report/) | the same findings as an HTML file; also **Open full report** in the pane |
| [Settings](/vibesenpai/reference/#settings) | `preset` and `mute` decide which free checks run |
