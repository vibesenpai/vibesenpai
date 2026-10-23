---
title: Your first finding
description: How to read what the tool prints, and why "no findings" is a real result.
---

Run it:

```
/agentsensei:now
```

```
  no findings across 2260 edits

  session 46b591a1 · 4617 events · 2260 edits · 2d5h

  SESSION COST
    1.3M out · 4.9M re-ingested · ratio 3.7 (corpus median 17.9)
    heaviest at turns 1617, 2800, 2775 — 35% of it

  CONTEXT
    compacted 6× — dropped 2.7M tokens of context
      turn    5   968k → 67k
      turn 2042   967k → 63k
      turn 3851   967k → 61k
      3 without reported sizes
```

## "no findings" is a clean bill of health

It is not a broken tool and it is not nothing-to-see. The detectors ran across
2,260 edits and none of them fired. That is the common case and it is supposed
to be.

This matters because the alternative — padding the output so it always looks
busy — is how a tool teaches you to ignore it.

## Reading the cost block

**`ratio 3.7`** is re-ingested tokens over output tokens. Every turn re-sends
the conversation, so a long session re-reads its own history many times over.
The corpus median is 17.9, so 3.7 is unusually efficient; a high ratio means a
lot of the spend went on re-reading rather than producing.

**`heaviest at turns …`** names where it concentrated, so you can go look.

**`compacted 4×`** is worth knowing on its own: a compaction discards context,
and an instruction given before one may simply not be there afterwards. If you
later see a `constraint_violation`, [this is why](/agentsensei/findings/fixes/).

## When something does fire

```
  ✗ edit_retry      4 edits refused, then retried    /agentsensei:fix
                    2× the text didn't match
                    2× the file wasn't read first
```

Every finding is anchored to real turns. `/agentsensei:fix` or `agentsensei fix`
gives you the one change worth making — and the turn numbers let you open the
transcript and judge for yourself, which is the point. A finding is evidence,
not a verdict.

## Across your history

```
/agentsensei:generate-report
```

It writes a self-contained HTML file — no JavaScript, no external resources,
mode 0600 — and prints the path.
