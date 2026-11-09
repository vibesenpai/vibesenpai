---
title: Cache rebuilds
description: Where the prompt cache was thrown away and written again. A statistic shown beside findings, not a finding.
---

## The dimension

| | |
|---|---|
| In the pane | Cache rebuilt |
| Key | none: it is not a detector |
| Tier | free check, computed from token figures Claude Code records |
| On by default | yes, computed for every session; listed when a rebuild happened |
| Confidence | none. It is a fact about the session, never a finding or a score (DECISIONS.md D66). |

## Description

Each model request reads the conversation so far from the prompt cache and writes
anything new to it. A rebuild is a request that found the cache gone and wrote the
whole prefix again.

Most cache figures are ordinary: totals grow with every session, and the read
share runs close to 100% by construction. A rebuild is different in kind, so it
is the one cache number shown, and only when one happened (DECISIONS.md D66).

What it is not:

- **Not a compaction.** A compaction replaces the prefix with a summary on
  purpose. A collapse right after one is not counted.
- **Not a finding.** It has no dimension block of its own, no confidence and no
  Hide button. It is listed beside the findings.

On one machine (46 sessions, observed on 2026-10-25, not a corpus frequency): 48
collapses, of which 10 followed a compaction, leaving 38 rebuilds that wrote 17.9M
tokens again. The median gap since the previous request was 4.9 hours, and one
rebuild came in under the 5-minute cache lifetime (docs/dimensions.md).

## Example conversation

From the public test data of [claude-code-log](https://github.com/daaain/claude-code-log) (MIT).

> **Developer**: "New feature: we support .zip, but I've seen an archive that contains embedded tar.gz. We should support those (.tar, .tar.gz) as well…"
>
> **Agent**: explores the code, asks the developer a question, writes a plan and
> asks for its approval, and edits the code, all in one long turn.
>
> **Turn 134**, inside that turn: a model request made 69 minutes after the
> previous one on that thread. The previous request had read 65,720 tokens from cache; this one found
> them gone and wrote 54,357.

In the pane, under **Cache rebuilt**, a rebuild is listed as:

```
turn 134 · a7da6a22 · 69 min after the previous request · 54,357 written
```

The block's summary line gives the count and the tokens written again across
sessions, and opening it lists the three largest.

## How it's detected

It reads only the token figures Claude Code records for each response, the thread
each response belongs to, compaction records and timestamps. No message text.

For each response, counted once even when it spans several records, on each
thread (the main conversation and each subagent):

1. The previous request on that thread read more than 20,000 tokens from cache.
   Below that floor, early turns swing legitimately.
2. This request read less than half of that, and wrote to cache.
3. There was no compaction on that thread since the previous request.

All three make a rebuild, recorded with its turn, the tokens written and the gap
since the previous request.

![How a cache rebuild is found](../../../diagrams/cache-rebuilds.svg)

## Applicable fixes

**There is no fix.** The only response to a rebuild after a long gap would be to
work in shorter sessions, which is advice, and advice is not something this tool
produces (docs/dimensions.md). Claude Code's one-hour cache setting
(`ENABLE_PROMPT_CACHING_1H`) is not offered either: on the measured gaps it would
have recovered about 4% of the rebuilt tokens, because the gaps are overnight
rather than minutes.
