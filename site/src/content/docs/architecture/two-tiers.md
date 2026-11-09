---
title: The two tiers
description: The free checks read structure and the compiler enforces it. The judge reads conversation, and it is a separate claim.
---

This page explains vibesenpai's two kinds of check: the free checks, which read
only structure, and the judge, a model that reads the conversation.

![The two tiers](../../../diagrams/two-tiers.svg)

## How do the two tiers differ?

| | the free checks | the judge |
|---|---|---|
| reads | structure: tool results, failure kinds, hashes, timestamps | the conversation text |
| confidence | `certain`: Claude Code recorded it | a model's reading |
| costs | nothing | your own quota, in the background, within 2M tokens a day |

Both show up the same way. The display does not say which tier a finding came
from; the method is kept in the data. The HTML report's footer says that most
findings are a model's reading and can be wrong.

## Why can a detector not read text?

A detector is the code behind one free check. It cannot read text because the
type it receives does not contain any:

```ts
export type StructuralEvent = Omit<Event, 'command' | 'pattern' | 'textSummary' | 'devCommand'>;
```

Those four fields come from text: the shell command, the search pattern, a
summary of prose or tool output, and a slash command the developer ran. `Omit`
removes them, so `e.command` inside a detector **fails the build**. A test
asserts that `command`, `pattern` and `textSummary` stay unreachable.

The rule exists because text-based detectors failed. Three of them, across
1,139 public sessions, produced **5 true positives against about 25 false
positives** ([GRAVEYARD.md](https://github.com/vibesenpai/vibesenpai/blob/main/GRAVEYARD.md)).
Each failure had the same cause: the detector read text to decide something.

## What does a detector read instead?

The parser is the only module that reads raw text. It turns text into closed
values a detector may use:

- `failureKind`, one of six values
- content hashes
- `truncatesOwnOutput`
- timestamps

For example, `edit_retry` checks `failureKind !== 'tool'`; it never reads the
error message.

**A harness string may name a finding; it may never produce one.** Labels are
attached after a finding already exists. If Claude Code rewords an error
message, the label goes missing and the finding still fires.

## Why is there a judge at all?

Structure has little left to give. In the public SWE-chat sessions, Edit and Write account
for **998 of about 1,400 tool refusals**, and `edit_retry` already covers both.

The remaining failures show in what was said, not in exit codes. For example,
`inaccurate_self_report` failed as a structural check (**0 true positives, 5
false**) and works as a judge dimension.

A judge finding that cannot quote the text it came from is discarded.
[How the judge works](/vibesenpai/architecture/judge/)
