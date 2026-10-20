# What we measured, and what we got wrong measuring it

**Re-measured 2026-10-19** over 1,139 real Claude Code sessions from SWE-chat, plus the dataset's own
annotations over 11,607,572 turns. Reproduce with `npm run measure`.

This document exists because three detectors shipped, 346 tests passed, and across 255 real sessions
they produced **0 findings and 19 false positives**. Its first version then ranked the dimensions by
frequency — and **three of those rankings were themselves wrong, in the same way.** Both rounds are
kept here, because the error is more instructive than the number.

---

## The current measurement

| occurs in | set A | set B | instances | dimension | probe |
|---|---|---|---|---|---|
| **51%** | 62% | 37% | 2,182 | `reading_spiral` | structural |
| **33%** | 37% | 28% | 927 | **`edit_retry`** | **detector** |
| 20% | 20% | 19% | 443 | `permission_denied` | structural |
| 11% | 12% | 10% | 125 | `context_reingest` | structural |
| 11% | 12% | 9% | 401 | `file_churn` | structural |
| 0.4% | 1% | 0% | 5 | `redundant_call` | structural |

**Set A** (n=640) is the friction-annotated subset and is therefore biased upward. **Set B** (n=499)
is a uniform random sample. The ranking is stable across both except `reading_spiral`, whose 62%/37%
gap is the widest in the table and the reason it is not built.

Denominators: 15,911 prompts, 35,574 edits, 156,654 tool calls, 5,354 harness-declared failures.
Tokens: 69.8M output, 591.9M cache creation. `cache_creation/output` per session: **p50 17.9, p90
159.5, p99 1815.9** (n=1,132).

Re-measured 2026-10-20, after fixing a per-record token overcount: a response is written as several
JSONL records which each repeat the same `usage`, and summing per record inflated output by 3.7x and
cache creation by 2.8x. The previously published figures were 97.1M / 694.7M and p50 12.0, p90 93.4,
p99 857.6.

`edit_retry`'s row says `probe: detector` — the shipped rule itself ran, so the figure and the product
cannot disagree. That is now a rule: **a built dimension is measured by its own detector, never by a
probe that resembles it.** The loose `tool_loop` probe reported 4% of sessions where the real detector
found 0.4%.

## The five probes that were wrong, and the one thing they had in common

**Each counted a harness mechanism and assumed it meant what its name suggested.**

| probe | claimed | what it actually counted |
|---|---|---|
| `user_interrupt` | 64% of sessions | **3,504 of 3,606 enqueues sit at a turn boundary**; only 102 land mid-flight, and of those carrying content **1,858 are `<task-notification>`** — the harness queueing its own messages |
| `prompt_withdrawn` | 37% — and "not in the catalogue" | not a dimension at all. `remove`/`popAll` carry **empty content** and sit between a `tool_use` and its `tool_result`. The arithmetic gives it away: `enqueue 3,606 ≈ dequeue 2,138 + remove 1,315` |
| `error_ignored` | 62% | of 234 matches, **≥68 were the agent fixing** and 55 more investigating. A non-zero exit is not an ignored error |
| `premature_external_write` | 38% | every push. Pushing to a personal branch where CI is the gate is normal and indistinguishable here |
| cache hit rate | 97.7%, "an outlier is real" | `cache_read` re-counts the **whole prefix on every call**, so it grows with the square of the turn count. Measured `read/(read+creation)`: **p10 0.901 → p90 0.985**. An "outlier" is just a short session |

`permission_friction` was also published as new; it is the second clause of the catalogue's existing
`user_interrupt` entry ("…**or denies a tool permission**").

The fifth was caught in review before it shipped, which is the only reason it is a row here rather
than a sixth deleted detector. The metric beside it survived: `cache_creation/output_tokens` spreads
7.5× p90/p50 and is behavioural.

### Two softer forms of the same error

Both caught later, by making every number reproducible:

- **Signal availability is not frequency.** 84% of sessions carry `file-history-snapshot` records;
  **11%** have file churn. The first number describes the format, not the developer.
- **A threshold-defined frequency is tautological.** `context_reingest`'s probe asks "above p90", so
  ~10% is arithmetic. Magnitude per session is the real question — which is why it is session
  metadata and not a finding.

## What the dataset's own annotations say

From `datasets-server` statistics over all **11,607,572 turns** — validated labels, not our probes:

| label | count | share |
|---|---|---|
| `prompt_pushback = correction` | **63,710** | 32% of annotated prompts |
| `prompt_pushback = failure_report` | 12,888 | 6% |
| `prompt_pushback = rejection` | 3,145 | 2% |
| **any pushback** | **79,743** | **40%** |
| `queue_op_subtype = user_prompt_discarded` | 18,638 | — |
| `bash_category = test/build` | 29,331 | **1.8% of 1.64M bash calls** |

Over just the 1,029 sessions whose transcripts we hold: 12,012 annotated prompts, **4,664
corrections (39%)**, 1,073 failure reports, 147 rejections. That is a ready-made silver label set, and
it is why `user_correction` is measurable rather than guesswork once the prompt cap is raised.

Persona, Claude Code sessions only (n=12,417):

| persona | sessions | median success | p10 |
|---|---|---|---|
| Expert Nitpicker | 5,404 (44%) | 82 | 52 |
| **Vague Requester** | 4,681 (38%) | 82 | 52 |
| Other | 1,391 (11%) | 75 | 20 |
| **Mind Changer** | 941 (8%) | **72** | 42 |

The paper's own headline numbers: users push back in **50% of turns**, only **59% of agent-written
code survives into commits**, 41% of sessions are "vibe coded", 25% have the human writing everything.

## Why the original catalogue ranked things wrong

The 40 dimensions came from five published taxonomies of **agent reasoning failures** — MAST,
Developer-Agent Misalignment, Model-or-Harness, OpenClawBench, Prompt-Quality→PR. Those papers study
whether agents reason correctly, and the catalogue inherits their rigour on that question.

What they do not study is **the harness being awkward to work in**. Reading 381 real friction
statements, the dominant themes are stale LSP diagnostics, tabs-versus-spaces edit failures,
local-passes-CI-fails, and the problem simply being hard. **Of those 381, 3 map to a process failure
that catalogue detects.**

That is the finding that drove the reset — and `edit_retry`, at 33% of sessions, is exactly a
harness-awkwardness dimension that no reviewed paper names.

## Confounds, stated because a number without them is not reportable

- **`reading_spiral`** does not exclude sidechains, where a parallel fan-out legitimately re-reads the
  same files. Widest set A/B gap in the table (62% vs 37%), which suggests annotation bias too.
- **`permission_denied`** counts the person declining, which is control rather than friction.
- **`context_reingest`** is a session ratio with no turn to anchor to — metadata, not a finding.
- **`file_churn`** counts from first touch, so a long session inflates versions. It needs the p90 of 5
  as a threshold, never an absolute count.
- **`redundant_call`** needs identical arguments *and* identical output, and a self-truncating command
  discards its own output upstream of us, so the digest compares a prefix.
- **`edit_retry`** counts only `failureKind: 'tool'`, so a declined or hook-blocked edit is excluded,
  and the attempt ends at the next user prompt.
- **`session_success` and `user_persona` are LLM-annotated** — silver, not ground truth.
- **Set A is selected**, being the sessions an LLM judge found worth annotating. Trust set B for rates.

## How this was measured

- `scripts/pull-swechat.ts` — pinned fetch of the per-turn label columns and both transcript sets.
  Reads Parquet with byte ranges, so the label columns cost **70 MB of a 6,127 MB file — 1.1% of the
  bytes for 100% of the labels**. Dev-only dependency, never in `src/`.
- `scripts/measure-dimensions.ts` — one probe per dimension, each declaring its own confound, and a
  built dimension measured by its own detector. Now under the typechecker, which it was not: the
  reset silently broke it while every check stayed green.
- Dataset pinned at revision `202b071f18e03c79df5a7287565ce2ebc5ee7756`. Transcripts fetched to
  scratch, never vendored.

---

*SWE-chat is ODC-BY. Baumann et al., "SWE-chat: Coding Agent Interactions From Real Users in the
Wild", arXiv:2604.20779.*
