---
title: Config, a tool, or nothing
description: Why a fix is often not a prompt — and why "no fix" is a real answer.
---

Most tools in this space end at "here is what went wrong". The interesting
question is what you do about it, and the honest answer is frequently *not a
prompt*.

Claude Code's own documentation splits its surfaces three ways, and the wording
is the whole distinction:

```
  DETERMINISTIC   permissions + command hooks   "enforced by Claude Code,
                                                 not by the model"
  MODEL-JUDGED    prompt / agent hooks          "a model's judgment, not a
                                                 guarantee"
  PROSE           CLAUDE.md, rules, memory      "context, not enforced
                                                 configuration"
```

A hook holds whether or not the model remembers. A prompt works while it is
paying attention. A `CLAUDE.md` line is read at the start and competes with
everything else for room.

So `fix` leads with the strongest mechanism that exists for your finding, and
keeps the weaker one underneath for when you would rather not configure
anything.

## The kinds

| kind | what it is |
|---|---|
| `GUARD` | a `permissions.deny` entry or a command hook — checked by the harness |
| `VERIFY` | a `Stop` hook that runs the real check instead of trusting the claim |
| `CONFIG` | a harness setting that changes behaviour, like plan mode |
| `PROMPT` | text for this session; honest that it is model-judged |
| `MEMORY` | a `CLAUDE.md` line — the weakest, never the default, and budget-checked |
| `EXTERNAL` | a pattern or tool someone else already built better |
| `REPORT` | **no fix exists.** A real answer |

Nothing is ever written for you. Every hook and setting is printed for you to
apply, and the cost is printed beside it — a `Stop` hook can refuse to let a
turn finish, and you should know that before pasting it.

## Three of seven dimensions have no fix

This is the part most tools would hide.

**`redundant_call`** — re-reading a file is cheap and frequently correct. A
dedup hook is buildable and would strand the model after a compaction, when the
content is genuinely gone. Not worth it.

**`other`** — unknown by construction. It collects a short descriptor each time
so that, after enough of them, the missing dimension becomes visible instead of
invented.

**`edit_retry` / file-not-read** — the harness **already refuses** an edit to a
file it has not read. That is *why* those retries happened. A rule asking for
the thing that is already enforced is what the research calls ceremonial: 66.7%
of rules in one study described behaviour that already complied.

Saying "nothing to do, the harness has this covered" is more useful than a rule
that looks like progress.

## When a constraint was compacted away

One case is worth calling out because the usual advice is actively wrong.

If you told your agent something at turn 400 and it broke that rule at turn
2700, with a compaction in between that discarded 900,000 tokens — the
instruction was probably not ignored. It was no longer there.

`fix` detects this and changes its answer accordingly: not "word the rule
better" but *move it somewhere a compaction cannot reach*. Enforcement survives
compaction because hooks and permissions are configuration. Conversation does
not.

Measured in the research: a governance constraint is violated **0% of the time
when it survives the summary, and 38% when it is dropped.**
