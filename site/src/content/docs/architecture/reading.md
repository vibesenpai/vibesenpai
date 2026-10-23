---
title: Reading a transcript
description: Why nothing is ever copied, and why walking the parentUuid tree would have been a silent bug.
---

## Nothing is copied, and that is a security decision

Local-first usually means "nothing leaves the machine". Necessary, not
sufficient — **the smallest attack surface is the one that does not exist.**

A transcript can contain a leaked token: an API key pasted into a prompt, a
`.env` echoed by a tool result. That exposure already exists in the harness's
file. *Copying it creates a second one*, in a directory we chose, with a
lifetime we chose, that you never asked for. If that copy is read by the wrong
process, synced, or swept into a backup, the breach is **ours**, from data that
was not ours to duplicate.

So transcripts are read with ranged reads and never opened for writing. `scan`
prints `copied nothing` because it is literally true:

```
scanned 16 transcripts · 16 new, 0 grown, 0 unchanged
read 55.7 MB · copied nothing
```

What is stored is a catalog of **byte offsets and hashes** — enough to know
what has already been read, not enough to reconstruct anything.

The cost is accepted rather than worked around: **no history beyond the
harness's own retention.** When Claude Code deletes a transcript, that session
is gone for us too. Copying was considered as an opt-in and rejected, because
the escape hatch would have brought back the copy writer, the prune loop and
the permission enforcement that not copying removes entirely.

## Redaction happens at construction

Not before display, and not before sending. The parser redacts as it builds
events, so nothing downstream ever holds the unredacted form. Everything built
on top is safe by default rather than by remembering.

Measured across the corpus: **50% of real sessions carry secret-shaped content**
at the fidelity the judge reads — API keys, JWTs, bearer tokens, URL
credentials — and tool output is where it concentrates.

## File order, not the tree

Every record carries a `parentUuid`, so a transcript looks like a tree. The
obvious design is to walk it: reconstruct the live path and ignore branches
left behind by rewinds.

**Measured against real sessions, that would be a bug.**

![A branch point with two live children](../../../diagrams/branch-point.svg)

The longest path covers only **1,325 of 1,695** records, and walking it drops
**46 real records — 39 of them `tool_result`s.**

That is the part that matters. A `tool_result` is where the harness records
whether a call failed and who refused it, and `edit_retry` reads exactly that.
The bug would not have crashed. It would have produced confident wrong
findings, quietly, forever.

The branch above is not a rewind at all — it is two parallel tool calls, which
is ordinary. Treating every branch as a discarded timeline throws away work the
agent actually did.

So events are flattened in **file order**, and the tree is used for what it is
good for: attributing subagent work. A subagent's work is a contiguous subtree,
so the topmost sidechain ancestor identifies the invocation that spawned it —
**712 of 712 sidechain events attributed, 96 distinct subagents.**
