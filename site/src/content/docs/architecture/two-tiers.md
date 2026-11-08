---
title: The two tiers
description: Rules read structure and the compiler enforces it. The judge reads conversation, and it is a separate claim.
---

Two tiers, and they are not equally reliable. Everything in the output keeps
them apart.

![The two tiers](../../../diagrams/two-tiers.svg)

## A detector cannot read text

Not by convention — by type.

```ts
export type StructuralEvent = Omit<Event, 'command' | 'pattern' | 'textSummary'>;
```

A detector receives `StructuralEvent[]`. Those three fields are the free-text
ones: the shell command, the search pattern, the summary of prose or tool
output. `Omit` removes them from the type, so `e.command` inside a detector is
not a review comment or a lint warning. **It fails the build.**

Three tests carry `@ts-expect-error` on exactly those accesses, so the rule
breaks the suite if the fields ever become reachable.

### Why the rule exists

This project shipped three detectors that read text. Across 1,139 sessions they
produced **5 true positives against roughly 25 false positives.** Every failure
had the same shape: the detector read text to decide something.

Text is an open space. There are thousands of toolchains and infinite
phrasings, so a rule over text is a guess with good manners — it cannot even
tell you what it missed.

### What a detector reads instead

The parser is the only module allowed to read raw text, and it converts text
into closed values a detector may use: `failureKind` (one of six), content
hashes, `truncatesOwnOutput`, timestamps. `edit_retry` checks
`failureKind !== 'tool'`; it never reads the message.

**A harness string may *name* a finding; it may never *produce* one.** Labels
are attached by the runner after a candidate already exists, so if Anthropic
rewords an error message the label goes missing and the finding still fires.
Losing a label is cosmetic. Losing a detection would be silent.

## The judge reads conversation

The structural well is dry, and that was measured rather than assumed: Edit and
Write account for **998 of roughly 1,400 tool refusals** in the public corpus,
and `edit_retry` already covers both.

The remaining failures are visible in what you *said*, not in exit codes. The
expensive proof: `inaccurate_self_report` was first built as a rule and died at
**0 true positives against 5 false.** The same dimension works as a judge
dimension. Same target, different tier, opposite outcome.

[How the judge works →](/vibesenpai/architecture/judge/)

## Two kinds of claim, one display

| | rule tier | judge |
|---|---|---|
| reads | structure | conversation |
| confidence | `certain` — the harness said so | a model's reading |
| shown as | the finding | the finding |
| costs | nothing | your quota, when you ask |

A judge finding that cannot quote the packet it came from is discarded on the
way out. The headline counts both tiers, and the display does not say which tier a
finding came from: that it was flagged is what matters. The method is kept in
the data, and the report's footer says most findings are a model's reading.
