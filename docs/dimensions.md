# Dimensions

What this tool detects, and the evidence for each. **Every frequency here comes from
`npm run measure`** over the pinned 1,139-session SWE-chat corpus, so each number can be reproduced
rather than trusted.

Rewritten 2026-10-19. The 40-dimension research catalogue that preceded it is
[dimension-survey.md](dimension-survey.md) — kept because the research is sound, marked clearly
because it must not be built from. `GRAVEYARD.md` holds what was deleted and why.

## The rule every dimension obeys

**A detector reads structure. A harness string may name a finding; it may never produce one.**

`DetectorContext.events` is `StructuralEvent` — `Omit<Event, 'command' | 'pattern' | 'textSummary'>`
— so reading text in a detector is a build failure. Three detectors shipped on text and produced 5
true positives against ~25 false positives. Text is an open space: thousands of toolchains, infinite
phrasings, and no way to know what was missed.

What the format *does* offer is an envelope. There are **no error codes anywhere** — verified across
all 5,354 failing results, every one a plain string — but the harness frames its own errors, and a
frame is structure:

| `failureKind` | frame | count | whose fault |
|---|---|---|---|
| `tool` | `<tool_use_error>…</tool_use_error>` | 1,424 | the tool refused the call |
| `denied` | `The user doesn't want to proceed…` | 398 | the person said no — their control |
| `cascade` | `Sibling tool call errored` | 113 | the call never ran |
| `hook` | `PreToolUse:Edit hook error: …` | 45 | the person's **own** hook |
| `permission` | deny rules / pending prompt | 6 | their settings |

Only `tool` is the agent fighting anything. Reporting a `hook` rejection as waste tells someone their
own safety rail is a problem, which is worse than silence.

## The voice

**What the session cost, with receipts** — not "you made a mistake". Naming a mistake requires
knowing intent, and that is precisely what produced the false positives. Every finding points at
specific turns; nothing is a score.

## Built

### `edit_retry` — the harness refused an edit, the agent pushed on

`RULE` · conf **`certain`** · scope `session` · per-edit · **core** · lower-is-better

```
Edit  src/api.ts   → <tool_use_error>File has not been read yet…
Read  src/api.ts
Edit  src/api.ts   → ok
```

| measured | |
|---|---|
| sessions with a finding | **380 / 1,139 — 33.4%** |
| instances | 927 (2.6% of 35,574 edits) |
| labelled with the harness's reason | 926 of 927 |
| hand-verified | 16 SWE-chat + all 12 pinned-corpus findings, **0 false positives** |

Structural fields only: the tool name (a closed four-entry harness list), `isError`, `failureKind`,
`filePath`, and order. Not the agent reasoning badly — the agent fighting the edit tool's exact-match
contract, which is the harness being awkward to work in.

**Guards, each one load-bearing:**

- **Only `failureKind: 'tool'`.** The other envelopes are the person's own control working.
- **The retry is what makes it waste.** A single refusal the agent accepts is the tool doing its job.
- **The attempt ends at the next user prompt** — a new instruction is a new request. Excludes 12 of
  939 (1.3%). Deliberately *not* also capped at N turns: the gap is p50 4, p75 6, p90 15, so a turn
  count would buy almost nothing and add a threshold with no basis.
- **A verdict pairs with the nearest *preceding* call.** Tool-call ids are not unique — one
  pinned-corpus file reuses 90 of them. Found by reading evidence; every test passed regardless.

**What the harness said**, across 927 instances — this is the advice, and it differs per reason:

| n | reason | advice |
|---|---|---|
| 528 | `not-read-first` | read the file before editing it |
| 224 | `string-not-found` | the quoted text did not match — re-read before editing |
| 96 | `stale-read` | a linter or you changed the file after it was read |
| 59 | `ambiguous-target` | the anchor matched several places — quote more context |
| 8 | `no-op` | the replacement was identical to the original |
| 8 | `bad-arguments` | the call was malformed |
| 3 | `missing-file` | the path does not exist |
| 1 | *(unrecognised)* | reason unknown — **the finding still stands** |

That last row is the label tier working as designed: reword a message and the detection is unaffected.

### `redundant_call` — same call, same answer, nothing changed between

`RULE+T` · conf **`certain`** (or `high`) · scope `session` · per-tool-call · **standard**

Groups by `toolName | argHash | outHash` across the **whole session** — the
layer the question belongs at, since a call is redundant with respect to a
session rather than to one actor's slice of it. That also means two actors
making the same call is visible, which a thread-scoped rule could not see.

**Aggregation alone is 93% wrong.** Three guards do the work:

```
  298  raw groups of 3+ identical calls with identical output
 -278  an EDIT between first and last   ← re-running after a change
 -  7  a USER PROMPT between            ← new instruction
 -  7  median gap >= 60s                ← waiting, not looping
 ----
    6  findings, all hand-read
```

The **edit guard** carries the most weight by far. `npm test` → fail → edit →
`npm test` → same failure is the agent trying a fix that did not work; that is
`fail_fix_fail`, and calling it redundant would be wrong about the only thing
that matters — whether the repeat was informed.

The **gap guard is the one threshold in the detector**, and it exists because
polling is usually written `sleep 60 && <command>`, which a detector may not
read. Timestamps are structural, and the populations separate on them:

```
  72s  sleep 60 && echo "Poll time"        x8    ← waiting
  66s  sleep 60 && gh api .../reviews      x9    ← waiting
  ───────────────────────────────────────────── 60s
  17s  go generate                         x3    ← real
   9s  npx tsc --noEmit | head -30         x5    ← real
   2s  Read, same file                     x3    ← real
```

**What the change cost, stated:** the previous consecutive-run version found 5;
this finds 6, gaining repeats spread across a session (`Bash` ×10, 32s apart)
and losing a `TodoWrite` ×3 at a 207s gap that the guard reads as waiting.

**Its known hole** is unchanged: a self-truncating command (`| head -30`) throws
its own output away upstream of us, so `outHash` compares a prefix. That
downgrades `certain` → `high`, never suppresses.

## Reported as metadata, not as findings

Both were planned as detectors. **Neither survived measurement**, for different
reasons.

### `file_churn` — the correlation is not there

High-churn paths that also show edit friction: **15%**, against a **9%** base
rate. That does not support a finding. Worse, of the 91 highest-churn paths in
the corpus, **30 are never touched by `Edit` at all** — `.continue-here.md` at
27 versions, `.planning/HANDOFF.json` at 27, `69-UAT.md` at 19. Those are files
whose purpose is to be rewritten, and reporting them as waste would repeat
exactly the mistake `revert_churn` made about a branch whose work had been
deliberately preserved.

**The obvious fix is also wrong.** "No `Edit` calls means regenerated" was the
plan, until a real local session showed `src/archive.ts` at **51 versions and 1
edit call** — heavy genuine editing done through `python3` heredocs in `Bash`.
Filtering on the edit count would have hidden the most-worked file in the
session. So both numbers are shown and neither filters: a reader seeing
`HANDOFF.json 27 versions, no edit-tool calls` beside `server.ts 18 versions, 59
edit calls` can tell those apart, and a filter guessing for them could not.

### `context_reingest` — exact, universal, unanchorable as a ratio

`cache_creation / output_tokens` per session: **p50 17.9, p90 159.5, p99 1815.9** (n=1,132).

> Re-measured 2026-10-20. These read p50 12.0, p90 93.4, p99 857.6 while a split
> response's `usage` was being summed once per record — see
> `src/parsers/claude-code.ts`. Both halves of the ratio were inflated, output
> by 3.7x against cache creation's 2.8x, so the ratio was wrong by about a third.
Exact, text-free, identical in meaning for every language and tool. But a
session-wide ratio has no turn to point at, and CLAUDE.md is explicit that
nothing is reported as a number without evidence behind it.

What *is* anchorable: **half a session's re-ingestion comes from 6% of its
turns** (p50; p10 is 1.3%). Concentrated, so the heaviest turns can be named —
a ranking, needing no threshold.

```
  SESSION COST
    1.9M out · 13.2M re-ingested · ratio 6.8 (corpus median 17.9)
    heaviest at turns 3586, 3587, 3588 — 11% of it

  MOST REWRITTEN
    51 versions  agentsensei/src/archive.ts                1 edit call
    34 versions  ~/.claude/plans/rosy-seeking-feather.md   81 edit calls
```

**`cacheRead` is recorded and never divided.** It re-counts the whole prefix on
every call, so `read/(read+creation)` runs p10 0.901 → p90 0.985 by
construction and an "outlier" is just a short session. `test/render.test.ts`
asserts it never reaches the output.

## Deliberately not built

| dimension | measured | why not |
|---|---|---|
| `permission_denied` | 20%, 443 instances | structural at last, via `failureKind` — but **declining is the person exercising control.** It is not obvious this should ever be surfaced, and "frequent and detectable" is not a reason to ship |
| `user_correction` | SWE-chat labels 4,664 corrections (39% of annotated prompts) | needs parser work first: `summarise()` caps text at 200 chars and **40% of prompts hit the cap**, so a correction at the end of a long prompt is invisible. Also an *anchor*, never surfaced alone — correcting is normal and healthy |
| `user_interrupt` | — | the published 64% was wrong: **3,504 of 3,606 enqueues sit at a turn boundary** and 1,858 are `<task-notification>`. Needs a real mid-action signal first |
| the verification family | — | `no_verification`, `tdd_fail_then_pass`, `premature_external_write`, `fail_fix_fail`. All need to know which command is a test, which is irreducibly framework-specific. Deleted knowingly; `no_verification` was the most actionable sentence this tool could produce |

---
## Machinery: how a dimension is described

The vocabulary below outlived the catalogue it was written for. Every entry above carries the same
fields, and the two that matter most are **how it is measured** and **how much to trust it.**

### How to read the measurement codes

The detection method determines everything downstream — cost, accuracy, whether it can run with no
dependencies, and whether a finding can be surfaced unprompted. Six methods, in increasing order of
cost and decreasing order of trustworthiness:

| Code | Method | Dependency | Cost / 1k turns |
|---|---|---|---|
| `RULE` | Deterministic structural check on the event stream. Fires only when the condition is *literally* true in the transcript. | none | <5ms |
| `RULE+T` | Same, with a tunable threshold (`≥3 edits`, `≥3 repeats`). Detection is exact; the *threshold* is a judgment call. | none | <5ms |
| `LEX` | Lexical / pattern matching on message text — keyword lists, regex, negation handling. | none | ~10ms |
| `EMB` | Embedding similarity via the bundled MiniLM (~25–90MB, lazy download). | model file | ~200ms |
| `CLS` | Small zero-shot or SetFit classifier for language signals. | model file | ~300ms |
| `JUDGE` | Local LLM with structured output (Ollama / Chrome Prompt API), **only** for windows still ambiguous after the above. | optional backend | ~2–5s |
| `STAT` | Statistical aggregate across many sessions. Not an event detector. | history | n/a |
| `+OUT` | Suffix: additionally requires outcome resolution (converged / abandoned / reverted), so it cannot confirm live. | — | — |

**Cost at scale — which methods survive which surface.** Per-window latency is fine in isolation and
misleading in aggregate: a 30-day report over ~40 sessions is roughly 600 windows.

| Method | `now` (1 session) | `report --last 30d` (~600 windows) | Verdict |
|---|---|---|---|
| `RULE`, `RULE+T`, `LEX` | <0.1s | **~3s** | viable everywhere |
| `EMB` | ~3s | **~2min** | viable live; cache by window hash, then viable for reports |
| `CLS` | ~5s | **~3min** | same — caching is what makes it viable, not speed |
| `JUDGE` | ~1min | **~30–50min** | **batch-only.** Never on a live path, never in an interactive report |
| `STAT` | n/a | seconds (reads stored findings) | aggregate only |

Three consequences: **`core` stays all-rule** so the default `report` is near-instant; **every `EMB`
and `CLS` verdict is cached by window hash** so a re-scan costs nothing (the design doc's "cache every
verdict" requirement, which matters far more for reports than for live use); and **`JUDGE` only ever
runs detached**, as a background pass whose results land in the store for the *next* read. A preset
that puts the judge tier on an interactive path is unusable, which is why `weak_evidence_commitment`
and `capability_overcommitment` sit in `all` rather than `standard`.

**The `core` preset is deliberately all `RULE` and `RULE+T`.** That is what makes the design doc's
"zero required dependencies for value" real rather than aspirational: the default experience needs no
model download, no Ollama, no network, and costs single-digit milliseconds.

### The confidence model — and its ceiling

Each finding ships with a confidence tier and the method that produced it. **No dimension has a
measured accuracy yet, because nothing is built** — the figures below are *a priori* expectations with
their basis stated, and `agentsensei eval` replaces each one with a measured number against the gold
set. Any claim of accuracy before that is exactly the "vibes" this project exists to reject.

| Tier | What it means | Expected precision | Basis |
|---|---|---|---|
| `certain` | The transcript literally contains the contradiction. If it fires, the condition *is* true. | **~1.0 by construction** | Not a prediction — a logical property. The only question is whether the user cares. |
| `high` | Threshold-based with well-separated classes; false positives are rare and explainable. | ~0.85–0.95 | Threshold tuned on the gold set. |
| `medium` | Text- or similarity-based. Paraphrase, idiom, and sarcasm cause misses. | ~0.65–0.85 | Comparable to published LLM-judge agreement (0.81 vs expert gold). |
| `low` | Inferential — needs a model, or an aggregate over weeks. | unknown until measured | Reported as a trend or provisional only; never surfaced unprompted. |

**There is a hard ceiling, and it is not 1.0.** The misalignment study reports **human inter-rater
agreement of 0.83** across its sub-axes, and its LLM judge reached **0.81** against expert gold. For
every subjective dimension — intent, frustration, overreach — *humans themselves disagree ~17% of the
time.* So ~0.85 is the realistic ceiling for that class of dimension, not a disappointing result. Only
the deterministic dimensions can approach 1.0, and that is a strong argument for keeping `core`
deterministic.

Two consequences wired into the product:

1. **Ambient surfacing requires `certain` or `high`.** `medium` and `low` findings exist only on
   `/sensei:now` and in `report`. This is enforced by the config's `minConfidence` and the separate
   `ambient` list.
2. **Every finding states its method.** "Flagged by rule" and "flagged by a local model at 0.7
   confidence" are different claims, and the UI never blurs them.

### Data requirements

Some dimensions cannot run without specific inputs. Everything built so far needs only `T`, which is
deliberate — a dimension that needs git state or a PreCompact capture is silent exactly when someone
is first trying the tool.

`T` transcript · `H` history.jsonl (prompts only) · `G` git / worktree state · `PC` PreCompact capture · `MS` multiple sessions · `TOK` token usage

Turning everything on would bury the signal and guarantee a false flag on day one — the exact failure
the precision principle exists to prevent. So dimensions are **selectable, with opinionated
defaults**, and the whole thing is config driven.

**Measured frequency is not a reason to promote a dimension.** The three detectors that led `core` on
assumed frequency were the ones deleted; `redundant_call` fires on 0.4% of sessions and earns its
place by never being wrong. `core` membership is about precision.

### Presets

| Preset | Count | Who it's for |
|---|---|---|
| **`core`** *(default)* | 1 — `edit_retry` | `certain`, rule-only, no model, and hand-verified at 0 false positives across 28 findings. The first finding a stranger sees decides whether they keep the tool. |
| `standard` | 2 — adds `redundant_call` | Sound, hand-verified 5/5, and far rarer at 0.4% of sessions. Precision earns it a place; frequency decides it is not the default. |
| `all` | — | Everything implemented, including low-confidence and experimental. |

**There is no mute surface yet.** `Config` carries no `preset` and no per-dimension `mute`, so the
only selection today is `detectorsFor(preset, only?)` in code. That is a gap, not a decision — a
dimension someone does not care about must be silenceable before more of them ship.
| `custom` | — | Explicit list; presets are just named lists, so there is nothing special about them. |

**`core` is these nine, and the reasoning is the same each time — common in the real world, provable
from a transcript, and hard to get wrong:**

`user_correction` · `inaccurate_self_report` · `constraint_decay` · `repeated_instruction` ·
`no_verification` · `tool_loop` · `scope_overreach` · `prompt_specificity` · `revert_churn`

Deliberately **not** in `core`: `rework_loop` and `fail_fix_fail` (highest false-flag risk in the
catalogue — they need their healthy twins working first), `irreversible_action` and `secret_exposure`
(reads as a security product, which this is not), anything requiring embeddings or a model, and
everything aggregate (`context_saturation`, `context_hygiene`) since they need weeks of data to say
anything.

### Config shape

Precedence follows the existing rule — CLI flag → env var → config file → default:

```jsonc
// $XDG_CONFIG_HOME/agentsensei/config.json
{
  "dimensions": {
    "preset": "core",                     // core | standard | all | custom
    "enable":  ["goal_drift"],            // additive to the preset
    "disable": ["tool_loop"],             // subtractive, wins over enable
    "groups":  { "risk_exposure": false },// whole groups on/off
    "thresholds": {
      "rework_loop":        { "minEdits": 4, "similarity": 0.8 },
      "tool_loop":          { "minRepeats": 3 },
      "unverified_acceptance": { "minDiffLines": 50 }
    },
    "minConfidence": "medium",            // suppress below this
    "ambient": ["constraint_decay", "inaccurate_self_report"]
  }
}
```

```bash
agentsensei report --preset all
agentsensei report --dimensions constraint_decay,no_verification
agentsensei report --no-dimensions tool_loop
agentsensei dimensions list                 # all 40: group, preset, status, confidence
agentsensei dimensions enable goal_drift
agentsensei dimensions explain goal_drift   # definition, signal, source, example
```

Four design points that matter more than the syntax:

1. **`ambient` is a separate, much shorter list.** What gets *surfaced unprompted* at the statusline
   is not the same question as what gets *computed*. Default ambient is two dimensions. Everything
   else is available on `/sensei:now` and in `report`. This is the main anti-nag control, and it is why
   enabling `all` does not make the tool noisy.
2. **Thresholds are config, not constants.** Every threshold in the catalogue (`≥3 edits`,
   `≥3 repeats`) is a tunable with a documented default, because `eval` tuning will move them and the
   right value differs per person.
3. **`dimensions explain <name>` ships the catalogue as data.** Each dimension carries its definition,
   signal, published source and example in-code — so the tool can always answer "why did you flag
   this, and who says it's a real pattern." That is the evidence principle applied to the taxonomy
   itself, not just to findings.
4. **A dimension not in the active set is not computed**, not merely hidden — so narrowing the set
   genuinely reduces work and keeps the footprint light.

**Build order for M2**, by yield per unit of effort — the `core` nine first, in this order:
`user_correction` → `inaccurate_self_report` → `no_verification` → `constraint_decay` →
`repeated_instruction` → `tool_loop` → `prompt_specificity` → `scope_overreach` → `revert_churn`.
Then the healthy-pattern discriminators (each gates its twin's precision), then outcome
classification, then `rework_loop` + `fail_fix_fail` last. `context_rationale_erosion` lands with the
`PreCompact` hook in M6.

---

---

---

*Extracted from the planning document (2026-10-12/15). Reasoning is kept with each
conclusion deliberately — see [DECISIONS.md](../DECISIONS.md) for the index.*
