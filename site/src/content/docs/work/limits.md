---
title: Limits
description: What this tool cannot do, and the one dimension that does not work.
---

## `overreach` does not work

It scores **2 of 38** against labelled data, across two models and three
pipeline versions. That is established, not provisional.

It ships anyway, and the honest reason is that removing a dimension is a
product decision nobody has made yet. If you see an `overreach` finding, treat
it as a reason to look rather than a conclusion.

## There is no gold evaluation tier

Every accuracy figure on this site is *silver agreement* — agreement with labels
that were themselves produced by a model, with human validation on a sample.
[The details](/vibesenpai/work/measuring/).

Until someone hand-labels a real set, this tool has no precision number and we
will not invent one.

## Claude Code only

One parser exists. The registry is designed for more and there is none.

## It cannot see your repository

The judge reads the conversation and the tool calls within it. It does not read
your code, your diffs, or your test suite. So a finding like "the agent
misunderstood the architecture" is outside what it can honestly assert, and
three of the research taxonomy's seven categories are deliberately not
implemented for exactly that reason.

## A `deny` rule is not a security boundary

When `fix` suggests a `permissions.deny` entry, it says this too: a rule written
for `pnpm add` does not match `npx pnpm add`, `pnpm -C dir add`, `sh -c 'pnpm
add'`, or someone editing `package.json` by hand. Claude Code's own
documentation says a Bash rule "isn't a security boundary", and we are not going
to imply otherwise by offering one without the caveat.

That is why the stronger suggestion is a `Stop` hook checking `git diff` — it
sees every write surface, including the shell.

## Findings are evidence, not verdicts

Everything is anchored to turns you can open and read. That is deliberate: the
tool is frequently a useful prompt to look at something, and occasionally wrong.
The anchor is how you tell which.
