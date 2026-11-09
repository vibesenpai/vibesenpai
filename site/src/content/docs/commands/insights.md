---
title: /vibesenpai:insights
description: Opens the pane beside the chat, with what has been found, the fixes, and the background jobs' health.
---

Opens the insights pane beside the chat: your findings, the fixes you can apply, and the health
of the background jobs.

```
/vibesenpai:insights
```

It takes no arguments.

## What it does

It shows what the background passes have already found. It sends nothing to a model and
spends no tokens; the model reads run only when a turn ends.

![The session-start summary from vibesenpai, then /vibesenpai:insights and the reply: Insights opened beside the chat.](../../../assets/docs/insights-open.png)

Claude Code prints `Insights opened beside the chat.` The pane stays open and refreshes when
there is something new. [A tour of the pane](/vibesenpai/start/pane/) describes every part of it.

## Where no pane can open

Claude Code cannot always draw a pane. Then the command prints a text version instead:

1. the session you are in
2. your history
3. how far the model reads have got

From a demo run over the public test data of
[claude-code-log](https://github.com/daaain/claude-code-log) and
[claude-code-sessions](https://github.com/frederick-douglas-pearce/claude-code-sessions) (both MIT):

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

The text version has no Apply and no answers. Those are only in the pane.

## Related

| | |
|---|---|
| [`/vibesenpai:judge`](/vibesenpai/commands/judge/) | turns the model reads on or off |
| [`/vibesenpai:report`](/vibesenpai/commands/report/) | the same findings as an HTML file |
| [Settings](/vibesenpai/reference/#settings) | which free checks run |
