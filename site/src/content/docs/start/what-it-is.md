---
title: What it is
description: Find out why your agents failed you — and an honest account of what this does and does not do.
---

`agentsensei` reads the transcripts your coding agent already writes, finds the
turns where effort was wasted, and tells you what that cost in tokens.

```
  11,000+ tokens discarded on 4 findings · 19 more flagged by a model
    18 sessions · 2,460 edits
```

The one detector measured end to end fires on **380 of 1,139 real sessions** —
one session in three — across **927 instances with zero false positives**,
hand-verified. That is an agent editing a file it had not read, or anchoring an
edit on text that had since changed: the harness refuses, the agent retries, and
you never notice because by the time you read the reply it worked.

It is a CLI and a Claude Code plugin. It runs on your machine, reads files in
place, and copies nothing.

## What it actually does

Three things, in order of how much you will use them:

**`agentsensei insights`** — what happened in the session you are in. Findings with
the turns they came from, plus what the session cost in tokens and how that
compares to the corpus median.

**`agentsensei report`** — the same across your history.

**`agentsensei fix`** — a recommendation, with the evidence for it. Or a
plain statement that no fix exists, which is a real answer here rather than a
shrug.

## What it is not

**Not a score.** There is no grade, no percentage of how good a prompter you
are. Those are unfalsifiable and they make people defensive.

**Not advice about you.** It will not tell you to communicate more clearly. Any
change it suggests is addressed to your *agent* — a hook, a setting, a line of
prompt — because that is a thing you can apply in one keystroke rather than a
habit you have to build.

**Not a dashboard.** `fix` returns a single recommendation. A tool that hands you six
problems has handed you nothing to do.

**Not finished.** Two rule detectors ship. The judge ships and is measured
honestly on [its own page](/agentsensei/work/measuring/) — including the one
dimension that does not work.

## Who it is for

If you use a coding agent for hours a day and have the vague sense that some of
that time is being spent re-doing work, this is for you.

If you want a leaderboard or a productivity metric, it is not — and nothing on
this site is going to change that, because the project has a standing rule
against numbers nobody can verify.

## Supported agents

**Claude Code only, today.** The parser layer is a registry and the internals
are harness-agnostic by design, but one parser exists. "Works with any agent"
is not a claim this project has earned.
