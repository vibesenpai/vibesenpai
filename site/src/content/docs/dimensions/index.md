---
title: The dimensions
description: Every kind of finding, which tier finds it, whether it runs by default, and how far to trust it.
---

A dimension is one kind of thing that went wrong. Each finding belongs to one,
points at the turns it came from, and comes with something applicable where one
exists.

![The dimensions, grouped by tier](../../../diagrams/dimensions.svg)

## Every dimension

| As the pane names it | Key | Tier | On by default | Confidence |
|---|---|---|---|---|
| [Constraint violation](/vibesenpai/dimensions/constraint-violation/) | `constraint_violation` | model read | yes | the model's own rating, per finding |
| [Misread intent](/vibesenpai/dimensions/misread-intent/) | `misread_intent` | model read | yes | the model's own rating, per finding |
| [Inaccurate self report](/vibesenpai/dimensions/inaccurate-self-report/) | `inaccurate_self_report` | model read | yes | the model's own rating, per finding |
| [Overreach](/vibesenpai/dimensions/overreach/) | `overreach` | model read | yes | does not work yet |
| [Other](/vibesenpai/dimensions/other/) | `other` | model read | yes | the model's own rating, per finding |
| [Edit retry](/vibesenpai/dimensions/edit-retry/) | `edit_retry` | free check | yes | `certain` |
| [Redundant call](/vibesenpai/dimensions/redundant-call/) | `redundant_call` | free check | no | `certain`, or `high` when the output was clipped |
| [Cache rebuilt](/vibesenpai/dimensions/cache-rebuilds/) | none | a statistic shown beside findings | yes | not a finding |

- **Model reads** send a redacted packet of the session to a model. They are on
  from installation and run from the `Stop` hook within a daily limit.
  `/vibesenpai:judge off` turns them off; the free checks keep running.
  [What leaves your machine](/vibesenpai/start/sends-and-costs/).
- **The free checks** read the transcript's structure on your machine, with no
  model and no network. The default preset, `core`, runs Edit retry. The
  `standard` preset adds Redundant call ([Reference](/vibesenpai/reference/)).
- **Cache rebuilt** is computed for every session and listed in the pane when a
  rebuild happened. It has no confidence because it is not a finding
  (DECISIONS.md D66).

The model's rating (high, medium or low) is stored with each finding. The pane
does not show how a finding was flagged, only that it was.

## Secondary kinds

A model read gives each finding one main kind. It may add up to two more of the
first four kinds when the episode is clearly those too, such as a broken rule
that was also unrequested work. The pane shows them after the main kind:
`also overreach`.

The main kind is the one that decides the lookback gate, the finding's id and
its fix. `other` is never a secondary kind. Misread intent and constraint
violation are added as secondary kinds only when the lookback gate found where
the expectation was set.

## Why `other` exists

Without it, a real problem that fits none of the four kinds has no label and is
dropped. The label stage is told to use `other` rather than force a poor fit,
and to give a 3 to 8 word descriptor with it. [Other](/vibesenpai/dimensions/other/)
has the details.

## How the pages are laid out

Each dimension page has the same five sections: the dimension, a description,
an example conversation, how it is detected, and the fixes on offer. Examples
come from the public test data of
[claude-code-log](https://github.com/daaain/claude-code-log) (MIT). Where that
data has no instance, the example is marked as illustrative.

The shared model pipeline (packet, two stages, quote anchoring, redaction) is on
[The judge pipeline](/vibesenpai/architecture/judge/). Dimensions that were built
and removed are in [the graveyard](/vibesenpai/work/graveyard/), and what is not
detected at all is in [What we do not detect](/vibesenpai/findings/not-detected/).
