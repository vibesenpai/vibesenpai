---
title: Your first finding
description: How to read what the tool prints, and why "no findings" is a real result.
---

Run it:

```
/vibesenpai:insights
```

```
  no findings across 2260 edits

  This session · 2 days, 2,260 edits

  Not read yet. This happens in the background once a turn finishes.

  The conversation was compacted 6 times (2.7M tokens of context).

  Most rewritten: cli.ts, 31 versions across 12 edits (and 8 others).

  Across your last 24 sessions

  4 edits were rejected and retried, across 3 files
     most often rosy-seeking-feather.md

  Last read 2026-10-23 11:48.

  Run /vibesenpai:fix for possible fixes
  Run /vibesenpai:report for more details
```

## "no findings" is a clean bill of health

It is not a broken tool and it is not nothing-to-see. The detectors ran across
2,260 edits and none of them fired. That is the common case and it is supposed
to be.

This matters because the alternative — padding the output so it always looks
busy — is how a tool teaches you to ignore it.

## Reading a cache flag

Cache numbers appear only when something abnormal happened. The one that does:

```
  ! cache rebuilt at turn 266, 2.8 hours after the previous request
    121,416 cache write  the cache held 147k before it
```

The prompt cache expires a few minutes after the last request. Come back
later and the whole conversation is written to cache again from scratch,
which in long sessions is most of what they write to cache at all. The line
says where, after how long, and how much; what to do about it is yours.

There is no hit rate and no running total. Every request re-reads the whole
conversation, so a hit rate sits near 99% for almost any session and tells
two sessions apart not at all.

**`compacted 4×`** is worth knowing on its own: a compaction discards context,
and an instruction given before one may simply not be there afterwards. If you
later see a `constraint_violation`, [this is why](/vibesenpai/findings/fixes/).

## When something does fire

```
  ✗ edit_retry      4 edits refused, then retried    /vibesenpai:fix
                    2× the text didn't match
                    2× the file wasn't read first
```

Every finding is anchored to real turns. `/vibesenpai:fix` or `vibesenpai fix`
gives you a recommendation — and the turn numbers let you open the
transcript and judge for yourself, which is the point. A finding is evidence,
not a verdict.

## Across your history

```
/vibesenpai:report
```

It writes a self-contained HTML file — no JavaScript, no external resources,
mode 0600 — and prints the path.
