---
title: The dimensions
description: Every kind of finding, which tier finds it, whether it runs by default, and how far to trust it.
---

A dimension is one kind of thing that went wrong in a session. Every finding
belongs to one dimension, points at the turns it came from, and comes with a fix
where one exists.

![The dimensions, grouped by tier](../../../diagrams/dimensions.svg)

## Every dimension

| Dimension | Tier | On by default |
|---|---|---|
| [Constraint violation](/vibesenpai/dimensions/constraint-violation/) | model read | yes |
| [Misread intent](/vibesenpai/dimensions/misread-intent/) | model read | yes |
| [Inaccurate self report](/vibesenpai/dimensions/inaccurate-self-report/) | model read | yes |
| [Overreach](/vibesenpai/dimensions/overreach/) | model read | yes, but it does not work yet |
| [Other](/vibesenpai/dimensions/other/) | model read | yes |
| [Edit retry](/vibesenpai/dimensions/edit-retry/) | free check | yes |
| [Redundant call](/vibesenpai/dimensions/redundant-call/) | free check | no |
| [Cache rebuilt](/vibesenpai/dimensions/cache-rebuilds/) | a statistic, not a finding | yes |

There are two tiers:

- **Model reads** send a redacted copy of the session to a model. They are on
  from installation and run in the background, started from Claude Code's
  `Stop` hook, within a daily limit.
  `/vibesenpai:judge off` turns them off; the free checks keep running.
  See [what leaves your machine](/vibesenpai/start/sends-and-costs/) and
  [the judge pipeline](/vibesenpai/architecture/judge/).
- **The free checks** read the transcript's structure on your machine, with no
  model and no network. The default preset, `core`, runs Edit retry. The
  `standard` preset adds Redundant call ([Reference](/vibesenpai/reference/)).

Each model-read finding stores the model's own confidence rating: high, medium
or low. A free-check finding is `certain`, or `high` when the evidence was
clipped. The pane does not show how a finding was flagged, only that it was.

## How a fix is chosen

A finding can have two kinds of fix:

- **Its own fix**, built from that finding's evidence, such as the command the
  developer forbade or their own words.
- **The kind's fix**, one per dimension, which fits any project.

The pane picks one per finding:

1. The finding's own fix, when it was built in the current project.
2. Otherwise the kind's fix.
3. Otherwise the finding's own fix from another project. The pane says so:
   "Built from a session in … Apply adds it to this project."

Every fix in the pane has Apply, except a `Stop`-hook check, which is printed
only. Apply writes a request into Claude Code's prompt box; nothing changes
until you press Enter, and the agent makes the change under Claude Code's own
permission prompt. [Fixes](/vibesenpai/start/fixes/) has the details.

## Secondary kinds

A model read gives each finding one main kind. It may add up to two more of the
first four kinds when the episode clearly fits them too, such as a broken rule
that was also unrequested work. The pane shows them after the main kind:
`also overreach`.

The main kind decides the finding's checks, its id and its fix. `other` is never
a secondary kind.

## How each page is laid out

Each dimension page has five sections: the dimension, a description, an example
conversation, how it is detected, and the fixes on offer.

Examples come from the public test data of
[claude-code-log](https://github.com/daaain/claude-code-log) (MIT). Where that
data has no instance, the example is marked as illustrative.

Dimensions that were built and later removed are in
[the graveyard](/vibesenpai/work/graveyard/). What is not detected at all is in
[What we do not detect](/vibesenpai/findings/not-detected/).
