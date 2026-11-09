---
title: Limits
description: What this tool cannot do, and how far to trust what it finds.
---

This page lists what the tool cannot see or measure, and where its findings
are weakest.

## How accurate are the model reads?

Model findings can be wrong. They are checked against a labelled research set,
and they agree with it on most sessions, not all
([How it was measured](/vibesenpai/architecture/measurements/)). That is why every finding shows its turns, and
why **Finding is wrong** exists.

The free checks are different: their findings are facts Claude Code recorded,
such as a refused edit.

## Which harnesses does it read?

Claude Code only.

## How far back can it see?

Only as far as Claude Code keeps transcripts. No copy is kept, so when Claude
Code deletes a session's transcript, that session is gone here too.

## Can it see my code?

Not directly. It never opens your repository; it sees only what the agent's
tools returned in the session (files it read, command output), so it cannot
judge code the agent never looked at.

The model reads follow the taxonomy of
[How Coding Agents Fail Their Users](https://arxiv.org/abs/2605.29442). Three
of its seven categories are not covered: wrong project diagnosis, faulty
implementation and operational execution error. The last two need the diff or
the full command text, which the model reads are not sent.

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
That fix is printed to copy. A Stop hook has no Apply: it needs your paths or
test command filled in, and an unfinished one would block every turn.

## Can a finding be wrong?

Yes. Every finding is anchored to turns you can open and read, so you can check
it against what happened.
