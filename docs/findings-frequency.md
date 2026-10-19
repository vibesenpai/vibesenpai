# Which dimensions developers actually hit

**Measured 2026-10-19** over 1,139 real Claude Code sessions from SWE-chat, plus the dataset's own
annotations over 11,607,572 turns. Reproduce with `npm run measure`.

This document exists because three detectors shipped, 346 tests passed, and across 255 real sessions
they produced **0 findings and 19 false positives**. Rather than build a fourth from the catalogue's
assumed order, we measured the order.

---

## The headline

**The three detectors we built rank 10th, 11th and 14th out of 14 measured dimensions.** Three
patterns that are *not in the catalogue at all* rank 4th, 6th and 7th.

| occurs in | set A | set B | instances | dimension | probe | in catalogue |
|---|---|---|---|---|---|---|
| **64%** | 66% | 60% | 9,929 | `user_interrupt` | structural | yes |
| **62%** | 69% | 53% | 3,352 | `error_ignored` | structural | yes ⚠ over-counts |
| **38%** | 43% | 32% | 1,989 | `premature_external_write` | structural | yes |
| **37%** | 39% | 34% | 4,898 | **`prompt_withdrawn`** | structural | **NO** |
| **34%** | 43% | 22% | 1,056 | `reading_spiral` | structural | yes |
| **33%** | 37% | 29% | 893 | **`edit_retry_friction`** | structural | **NO** |
| 18% | 18% | 18% | 398 | **`permission_friction`** | structural | **NO** |
| 12% | 14% | 10% | 1,533 | `no_verification` | structural | yes |
| 9% | 11% | 7% | 159 | `tdd_fail_then_pass` | structural | yes |
| 9% | 9% | 8% | 190 | `revert_churn` | structural | **built** |
| 4% | 5% | 3% | 64 | `tool_loop` | structural | **built** |
| 1% | 1% | 1% | 15 | `scope_overreach` | structural | yes |
| 1% | 1% | 1% | 13 | `fail_fix_fail` | structural | yes |
| 1% | 0% | 1% | 8 | `inaccurate_self_report` | lexical | **built** |

**Set A** (n=640) is the friction-annotated subset and is therefore biased upward. **Set B** (n=499)
is a uniform random sample of Claude Code sessions. The ranking is stable across both, which is the
check that matters — `reading_spiral` is the only row where the bias is large (43% vs 22%).

Denominators for the run: 15,911 prompts, 31,028 edits, 156,654 tool calls, 5,354 failures, 6,836
success claims. Verification was learned for 1,949 commands; **226 of 1,139 sessions (20%) are warm**,
which is the ceiling on anything verification-dependent.

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

Persona, Claude Code sessions only (n=12,417):

| persona | sessions | median success | p10 |
|---|---|---|---|
| Expert Nitpicker | 5,404 (44%) | 82 | 52 |
| **Vague Requester** | 4,681 (38%) | 82 | 52 |
| Other | 1,391 (11%) | 75 | 20 |
| **Mind Changer** | 941 (8%) | **72** | 42 |

The paper's own headline numbers: users push back in **50% of turns**, only **59% of agent-written
code survives into commits**, 41% of sessions are "vibe coded", 25% have the human writing everything.

## Three dimensions the catalogue is missing

These came out of reading 381 real friction statements in `summary_friction`, then measuring them.

**`prompt_withdrawn` — 37% of sessions, 4,898 instances.** The user types a prompt while the agent is
working, then takes it back (`remove`/`popAll` on the queue). They had something to say, reconsidered,
and cancelled. SWE-chat annotates the same event as `user_prompt_discarded` (18,638 dataset-wide).

**`edit_retry_friction` — 33% of sessions, 893 instances.** An edit fails and the agent retries the
same file. Of 811 edit calls in an earlier sample, 45 failed and 35 were retried; the reasons split
between *string-not-found* (whitespace or a stale read) and *file-not-read-first*. This is the agent
fighting the tool's exact-match contract, and it is pure waste.

**`permission_friction` — 18% of sessions, 398 instances.** A tool call the user declined. Not
necessarily friction — declining is control — but it is frequent, structural, and currently invisible.

## Why the catalogue ranked these wrong

The 40 dimensions were derived from five published taxonomies of **agent reasoning failures** — MAST,
Developer-Agent Misalignment, Model-or-Harness, OpenClawBench, Prompt-Quality→PR. Those papers studied
whether agents reason correctly. They are good at that and the catalogue inherits their quality.

What they do not study is **the harness being awkward to work in**. Reading the friction text, the
dominant themes are stale LSP diagnostics, tabs-versus-spaces edit failures, local-passes-CI-fails,
and the problem simply being hard. Of 381 friction statements, 3 map to a process failure our
catalogue detects.

## Recommended build order

Ranked by measured frequency, with feasibility accounted for.

1. **`user_correction`** — the dataset labels 63,710 instances and the paper puts pushback at 50% of
   turns. It is the catalogue's own "anchor signal", it is unbuilt, and **SWE-chat's `prompt_pushback`
   is a ready-made silver label set, so precision and recall are measurable without hand-labelling.**
2. **`prompt_withdrawn`** (new) — 37%, purely structural, no text anywhere in the path.
3. **`edit_retry_friction`** (new) — 33%, purely structural, and the one dimension that is unambiguous
   waste rather than a judgment call.
4. **`user_interrupt`** — 64%, but needs the published 4.5% baseline to separate signal from steering,
   since interrupting to add information is healthy.
5. **`no_verification`** — 12%, and capped at the 20% of sessions that are warm. Still the most
   directly actionable sentence the tool can produce.

**Deprioritised, with the reason stated:** `error_ignored` ranks 2nd by frequency but its probe
over-counts badly — of 234 matches, ≥68 were the agent fixing or re-checking and 55 more were
investigating. It needs an allowlist of benign non-zero exits before the number means anything.
`premature_external_write` needs branch awareness. `inaccurate_self_report`, `tool_loop` and
`revert_churn` are built and stay, but should not be the surfaces the product leads with.

## Confounds, stated because a number without them is not reportable

Every probe in the table carries its confound in `scripts/measure-dimensions.ts` output. The ones that
most limit the figures above:

- **`error_ignored` over-counts**, as described. Treat 62% as an upper bound.
- **`premature_external_write`** counts a push with no verification since the last edit. Pushing to a
  personal branch where CI is the gate is normal and indistinguishable here.
- **`reading_spiral`** does not exclude sidechains, where a parallel fan-out legitimately re-reads the
  same files. Its set A/B gap (43% vs 22%) is the largest in the table and suggests annotation bias
  as well.
- **`no_verification`** is silent on cold projects, so 12% is measured against the 20% of sessions
  where we know what verification means. Verification outside the session is invisible.
- **`tool_loop`** needs both an argument digest and identical output; a piped command masks its own
  exit status, and 111 of 127 verdict-bearing results are pipelines.
- **`session_success` and `user_persona` are LLM-annotated** — silver, not ground truth.
- **Set A is selected**, being the sessions an LLM judge found worth annotating. Trust set B for rates.

## How this was measured

- `scripts/pull-swechat.ts` — pinned fetch of the per-turn label columns and both transcript sets.
  Reads Parquet with byte ranges, so the label columns cost **70 MB of a 6,127 MB file — 1.1% of the
  bytes for 100% of the labels**. Dev-only dependency, never in `src/`.
- `scripts/measure-dimensions.ts` — one probe per dimension, structural wherever possible, each
  declaring its own confound.
- Dataset pinned at revision `202b071f18e03c79df5a7287565ce2ebc5ee7756`. Transcripts fetched to
  scratch, never vendored.

---

*SWE-chat is ODC-BY. Baumann et al., "SWE-chat: Coding Agent Interactions From Real Users in the
Wild", arXiv:2604.20779.*
