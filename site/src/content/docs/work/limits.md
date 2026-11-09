---
title: Limits
description: What this tool cannot do, and the one dimension that does not work.
---

This page lists what the tool cannot see or measure, and where its findings
are weakest.

## Which dimension does not work?

`overreach`. Against labelled data it scores **1, 1 and 2 of 38** across three
experiment arms and two models
([GRAVEYARD.md](https://github.com/vibesenpai/vibesenpai/blob/main/GRAVEYARD.md)).
That result is settled, not provisional.

It still ships, because removing a dimension is a product decision that has not
been made. An `overreach` finding is a pointer to a turn, not a conclusion.

## How accurate is the judge?

There is no gold figure. Every accuracy number on this site is **silver
agreement**: agreement with labels that a model produced, checked by people on a
sample. Until someone hand-labels a real set, there is no precision number, and
none is invented.

## Which harnesses does it read?

Claude Code only. The parser layer is a registry built for more, and it holds
one parser.

## Can it see my code?

No. The judge reads the conversation and the tool calls in it. It does not read
your code, your diffs or your test results.

So "the agent misunderstood the architecture" is not something it can assert.
Three of the seven symptom categories in the research taxonomy it follows are
not implemented for that reason.

## Is a permission fix a security boundary?

No. When a finding names a command you had ruled out, its fix is a
`permissions.ask` entry in `.claude/settings.local.json`. Claude Code then asks
before running that command. It is a prompt, not a wall.

A rule for `pnpm add` does not match:

- `npx pnpm add`
- `pnpm -C dir add`
- `sh -c 'pnpm add'`
- a hand edit to `package.json`

Claude Code's own documentation says a Bash rule "isn't a security boundary".

A `Stop` hook that checks `git diff` sees every write, including the shell's.
That fix is printed to copy and has no Apply: a hook that exits 2 with an
unfilled placeholder would block every turn.

## Can a finding be wrong?

Yes. Every finding is anchored to turns you can open and read, so you can check
it against what happened.
