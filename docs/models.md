# Semantic analysis (models)

> ⚠ **SUPERSEDED (2026-10-22).** This document specifies an embeddings → NLI cross-encoder →
> optional-local-LLM cascade. **None of it was built.** The semantic tier that exists is the
> two-stage hosted judge in [`src/judge.ts`](../src/judge.ts), described in
> [architecture.md](architecture.md#the-judge) and
> [dimensions.md](dimensions.md).
>
> It is kept because the reasoning is still worth reading — in particular *why embeddings shortlist
> but never decide*, which is the argument that `cosine("use pnpm, never npm", "ran pnpm install")`
> scores high while the correct answer is "no problem here". That reasoning is why the judge reads
> conversation rather than matching patterns near it, so the conclusion survived even though this
> design did not.
>
> The dimension names here are also stale — `tool_loop`, `revert_churn`, `no_verification` were all
> deleted (`GRAVEYARD.md`).


## How models and classifiers actually work here

The MVP ships **no models** — `core` is all rules. This section specifies the M5 tier, because two of
its requirements constrain the M1/M3 architecture and cannot be retrofitted cheaply.

### Why models at all — what rules genuinely cannot do

Rules are exact but literal. Three things defeat them:

| Rules can't | Example | Needs |
|---|---|---|
| Recognise **paraphrase** | "use pnpm" vs "stick to pnpm please" vs "we're a pnpm shop" | embeddings |
| Score a **judgment** | is this prompt specific enough? (0/1/2) | classifier |
| Read **semantics** | is this claim supported by the evidence in context? | LLM judge |

Everything else in the 40 — contradiction, repetition, missing verification, scope, reverts — is
structural, which is why the `core` nine need nothing.

### Model selection — researched, with sizes

All verified available for Transformers.js / ONNX Runtime in Node on 2026-10-13. Budget: a few hundred
MB, downloaded **eagerly** rather than lazily (the user's call, and the right one — a background lazy
download means partial-file states, mid-session failures, and error handling in a path nobody is
watching).

| Role | Model | Size | Why this one |
|---|---|---|---|
| **Embeddings** | [`onnx-community/embeddinggemma-300m-ONNX`](https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX) | **175MB** (`q4f16`) · 197MB `q4` · 309MB int8 · 617MB fp16 | **#1 on MTEB under 500M params (69.67)**. 525k monthly downloads, so the ONNX export is well-exercised. `all-MiniLM-L6-v2` from the earlier draft is far weaker and only wins on size — which we no longer need to optimise. |
| **Decision / contradiction** | [`Xenova/nli-deberta-v3-base`](https://huggingface.co/cross-encoder/nli-deberta-v3-base) *(xsmall & small also available)* | ~90MB int8 | **92.38% on SNLI-test**; xsmall still gets 91.64% / 87.77% MNLI-mismatched. This is the false-positive fix — see below. |
| **Ordinal scoring** | SetFit heads on the EmbeddingGemma vectors | **kilobytes** | Trained offline, bundled in the package. Free once the embedder exists. |

Total first-run download ≈ **270MB**, one time.

Alternative worth benchmarking at M5: [`onnx-community/ModernBERT-base-nli-ONNX`](https://huggingface.co/onnx-community/ModernBERT-base-nli-ONNX)
(86k monthly downloads) — ModernBERT is a newer, faster backbone than DeBERTa-v3, though its NLI
accuracy is not published on the model card, so it needs measuring against our own gold set rather
than taking on trust.

### The false-positive answer: NLI cross-encoders, not cosine similarity

This is the most important finding of the research, and it directly addresses the concern about false
positives.

**Bi-encoder embeddings cannot do this job.** Cosine similarity measures *topical* closeness, not
*logical* relationship:

```
cosine("use pnpm, never npm", "ran npm install lodash")   → HIGH   ✓ correctly suspicious
cosine("use pnpm, never npm", "ran pnpm install lodash")  → HIGH   ✗ FALSE POSITIVE
```

Both score high because both are *about* package managers. Thresholding that produces exactly the
confident nonsense being worried about.

**A cross-encoder NLI model answers the actual question.** It takes a *pair* — premise and hypothesis
— and returns `entailment` / `neutral` / `contradiction`:

```
premise:    "the user requires pnpm and prohibits npm"
hypothesis: "the agent ran `npm install lodash`"     → CONTRADICTION  ✓ flag it
hypothesis: "the agent ran `pnpm install lodash`"    → ENTAILMENT     ✓ stay silent
```

Correct in **both** directions, because NLI models are trained on negation and logical relation rather
than topic. At 92.38% SNLI accuracy, off the shelf, no training needed, ~90MB.

**And this generalises further than expected: a large share of our dimensions are fundamentally
contradiction detection.**

| Dimension | Premise | Hypothesis |
|---|---|---|
| `constraint_decay` | the stated constraint | the action taken |
| `inaccurate_self_report` | the last verification result | the agent's success claim |
| `weak_evidence_commitment` | the evidence available in context | the claim made |
| `goal_drift` | the opening request | the current work |

### Consequence: the `JUDGE` tier may be deletable entirely

`weak_evidence_commitment` and `capability_overcommitment` were the **only** two dimensions requiring
a local LLM — and both are entailment questions: *does the available evidence support this claim?*
That is precisely what an NLI cross-encoder decides, at 92% accuracy, in ~50ms rather than 2–5s.

**So the plan is to attempt both at M5 with NLI, and if they clear the gold-set bar, drop the Ollama /
LM Studio / llama-server tier before it is ever written.** That removes the heaviest optional
dependency, the slowest code path, and a whole class of "is a backend running?" failure modes —
leaving a stack with **no LLM dependency at all**, which was the stated preference anyway.

The honest caveat: SNLI/MNLI are clean, short, crowd-written sentence pairs. Our premises and
hypotheses are synthesised from transcripts and will be messier, so **92% is an upper bound, not an
expectation.** It gets measured on the gold set like everything else.

### Keeping false positives down — six concrete mechanisms

Model choice alone is not enough. Each of these is a design requirement, not a hope:

1. **Never threshold cosine alone.** Embeddings shortlist; NLI decides. Enforced by the detector
   interface — a dimension marked `EMB` cannot emit a finding without a second-stage verdict.
2. **Structural precondition AND semantic verdict.** `constraint_decay` requires both a matched
   command-shaped action *and* a `contradiction` verdict above threshold. Either alone is insufficient.
3. **Asymmetric thresholds.** Precision over recall is a stated principle, so thresholds are set to
   miss rather than over-fire, and that tradeoff is calibrated on the gold set — not left at defaults.
4. **A negation/antonym fixture class**, specifically adversarial: `use X` vs `don't use X`, `always`
   vs `never`, superseding instructions, double negatives. These are the cases that break similarity
   approaches, so they are a required test category rather than an afterthought.
5. **The NLI score ships with the finding.** "contradiction, 0.94" is inspectable; a bare assertion is
   not. Consistent with the evidence principle applied to our own machinery.
6. **`unknown` over guessing**, as everywhere else: a verdict in the ambiguous band produces no
   finding, not a low-confidence one.

### When the download triggers — the full matrix

Eager download is correct: lazy background fetching means partial files, failures mid-session, and
error handling in a path nobody is watching. But *eager* is about **how** it downloads, not **when**.
The trigger rules matter more, and one context must never download at all.

**Never bundled, never on install.** 270MB cannot go in the npm tarball — `npx` would re-fetch it
every run — and a `postinstall` script that pulls 270MB is hostile and frequently blocked in
corporate environments. Models are fetched separately into the configured data dir, which is also why
they survive `npx` re-runs.

| Context | Trigger behaviour |
|---|---|
| `agentsensei models install` | Downloads. The explicit, documented way. |
| `agentsensei init` | **Offers** it as a setup step, with the size stated. Declining is normal and remembered. |
| Interactive CLI needing a model dimension | **Prompts once**: *"3 dimensions need models (~270MB). Download now? [y/N]"* — then remembers the answer either way. |
| `--with-models` | Downloads without prompting. For scripts and for people who already decided. |
| `--no-models` | Never downloads; model dimensions are skipped silently. |
| **Inside a hook** (`Stop`, `SessionStart`, `SessionEnd`, `PreCompact`) | **Never downloads. Not ever, under any configuration.** |
| Non-interactive / no TTY (CI, pipes) | Never downloads. Skips model dimensions, one line to stderr. |

**The hook rule is absolute and follows directly from Principle Zero and Principle One.** A hook that
started a 270MB download would block a session, or fail in the background where nobody can see it, or
both. So in a hook context the model tier is simply treated as unavailable: model-dependent dimensions
are skipped, and the rules tier — which covers all of `core` — runs as normal. The download is a
foreground, user-initiated action, always.

**Config does not trigger anything.** Setting `dimensions.preset: standard` enables dimensions that
need models; it does not cause a download. The next interactive run prompts; hooks and non-interactive
runs skip. Config expresses intent, never side effects — the same rule that keeps the tool out of the
user's harness settings.

**State is remembered, so nobody is asked twice.** The answer to the prompt is persisted: installed →
never ask; declined → never ask again (re-offer only via `models install` or `doctor`). A new model
*version* is reported by `doctor` and never auto-fetched, because a silent swap would invalidate every
cached verdict without the user knowing.

**Download mechanics:** visible progress bar, resumable on interruption, checksum-verified, written to
a temp path and moved into place atomically so a kill cannot leave a half-model that looks valid.

**Concurrency — adopted from mem0's `ensure_deps.sh`.** Two sessions can start at once, so the
download takes an atomic `mkdir` lock in the data dir; a second process waits (bounded), then reports
rather than starting its own download. Failure writes a sentinel file so later runs and other sessions
can report it instead of silently retrying. A stamp file holding the model manifest (names, versions,
checksums) is what decides whether anything needs downloading at all — so the steady-state check is
two `stat` calls.

**Failure is not an error.** If Hugging Face is unreachable — offline, firewalled, rate-limited — the
message names what was lost and what still works: *"model download failed (network). Rules-only
analysis still available; 3 dimensions skipped."* Exit code stays 0. `doctor` reports which models are
present, their versions, their disk footprint, and whether a download was declined.

**The rules tier must remain fully functional with zero models present** — that is what makes the
download optional rather than a gate, and it is the same invariant that keeps `core` dependency-free.

### Tier 1 — embeddings (`EMB`)

**What it is:** the embedding model selected above (EmbeddingGemma-300m), run locally via
Transformers.js on ONNX Runtime in Node. Text in, a vector out; similar meaning → vectors close under
cosine similarity. **No training, no labels — it is a distance function.**

**Used by:** `repeated_instruction` (is this user turn the same ask as an earlier one?), `goal_drift`
(is current work still about the opening request?), `abandonment` (is this new session resuming an
abandoned goal?).

**Mechanics:** embed each user turn once, cache by content hash, compare pairwise cosine. Threshold
starts around 0.85 and is tuned against the gold set — it is config, not a constant.

**The failure mode that matters:** cosine similarity does not understand negation — *"use pnpm"* and
*"never use pnpm"* embed almost identically. **So embeddings retrieve candidates; they never decide.**
The second stage is the NLI cross-encoder above, which is trained precisely on logical relation rather
than topic. This is enforced in the detector interface, not left to discipline.

### Tier 2 — classifiers (`CLS`), and why they are nearly free

**The key architectural fact: a classifier is a trained head on top of the embeddings we already
have.** With SetFit-style few-shot training, the classification head is a logistic regression over
the 384-dim vector — **a few kilobytes of weights.** Once the embedder is downloaded, every
classifier after it costs essentially nothing in size and microseconds in runtime.

**So the real download boundary is EMB, not CLS.** Crossing into embeddings is the expensive decision;
adding classifiers afterwards is not.

**Used by:** the three `prompt_*` quality dimensions (ordinal 0/1/2), paraphrase recovery for
`user_correction`, `underspecified_prompt`, `fail_to_ask_clarification`.

**Where the training labels come from — this is the unlock.** SWE-chat ships **LLM-judge labels at
scale**: pushback category (correction / rejection / failure report) and prompt intent across 229,000
prompts. So:

1. Train the heads **offline, during development**, on SWE-chat's labels plus our hand-labelled gold set.
2. **Bundle the resulting weights** (kilobytes) in the npm package.
3. Users train nothing and download nothing beyond the embedder.

The honesty requirement: heads trained on LLM-judge labels inherit that judge's ~0.81 accuracy as a
ceiling. They are reported at `medium` confidence and scored against the **gold** tier, never against
the silver labels they were trained on — training and evaluating on the same labels would be
measuring our ability to imitate a judge, not to be correct.

### Tier 3 — local LLM judge (`JUDGE`), and why it may never ship

**What it is:** a local model via Ollama (`localhost:11434`) or any OpenAI-compatible server —
LM Studio `1234`, Jan `1337`, llama-server `8080`. One client covers all of them. Default
`qwen3.5:4b`, chosen by available RAM. Structured output via Ollama's `format` with a JSON schema,
temperature 0.

**Used by:** only `weak_evidence_commitment` and `capability_overcommitment` — and only for windows
still ambiguous after everything above.

**Prompt design is constrained by the smallest realistic context (~4K tokens):** rubric, two or three
examples, **one** skeleton window, terse JSON out. This is a hard constraint on the skeletonizer —
see below.

**Cost:** 2–5s per window, so ~30–50 minutes for a 30-day report. **Batch-only, never on a live or
interactive path.**

**Status: likely to be deleted before it is written.** Both of its dimensions are entailment
questions that the NLI cross-encoder answers at ~92% in ~50ms instead of 2–5s. M5 attempts them with
NLI first; this tier is only built if NLI measurably fails on the gold set. The interface stays
defined so that outcome is a configuration change rather than a refactor.

### Tier 4/5 — Chrome Prompt API, user's own key

Dashboard-only (`LanguageModel.availability()` then `create()` after a user gesture, feature-detected,
degrading silently on Firefox/Safari or under enterprise policy), and opt-in BYO key. Neither is on
the critical path. Both inherit the silent-update problem below.

### The cascade — escalate only on ambiguity

```
  rules (always, free)
    └─ verdict is `certain`?            → STOP. no model runs. ever.
    └─ needs similarity?                → EMB (cached by content hash)
         └─ needs a judgment?           → CLS (free once EMB is loaded)
              └─ still ambiguous?       → JUDGE  (batch contexts only)
                   └─ no backend?       → report `unknown`. never guess.
```

Two invariants:

1. **Every tier is optional.** Missing a backend removes dimensions; it never degrades the ones that
   remain. The `core` nine are unaffected by any of this.
2. **Absence is reported, not guessed.** A dimension needing a backend that is not present says so —
   the same discipline as the outcome tri-state.

### Caching and the silent-update problem

**Cache key: `hash(skeleton format version + window content + detector version + model name + model version)`.**

The model version in that key is not optional. Ollama models get updated, Chrome's built-in model
updates silently with the browser, and a bundled classifier head changes when we retrain. A cached
verdict from a different model version is a different claim, so it must miss rather than hit.

Consequently every stored verdict records the backend and version that produced it, and **`eval`
re-runs automatically when a version changes** — otherwise precision figures silently describe a
model that is no longer running.

### What this forces into M1 and M3 — the part that cannot wait

Five decisions that are cheap now and expensive later:

1. **Detectors must be `async` from the start.** Model calls are async. A synchronous detector
   interface would force a rewrite of all 13 MVP detectors at M5.
2. **Findings carry `method`, `confidence`, and optional `backend` + `modelVersion`** — the schema
   from M1, even while every value is `RULE`/`certain`/null.
3. **The `Backend` interface is defined in M1** with exactly one implementation: a null backend whose
   `available()` returns false. Every later tier plugs into it without touching detectors.
4. **The verdict cache table exists in the M3 schema**, with the composite key above, even while
   nothing writes to it. The skeleton format version belongs in that key from the start — it is what
   lets the rendering evolve without silently reusing verdicts computed against a different shape.
5. **The skeletonizer targets ~2K tokens per window** — because a window must fit a 4K-context prompt
   alongside a rubric and examples. **The skeleton is the model's input format**, so its design is
   constrained by a tier that does not exist yet. This is the single most consequential item here, and
   it also aligns with the skeleton being the future team product's wire format.

### Net recommendation

**Ship `EMB` + `NLI` + `CLS` as one ~270MB download at M5** — EmbeddingGemma-300m for retrieval, an
NLI cross-encoder for every decision, bundled SetFit heads for the ordinal scores. **Attempt the two
`JUDGE` dimensions with NLI and delete that tier if it works**, leaving no LLM dependency anywhere in
the system. The `core` nine, which need none of this, cover the three highest-prevalence failures in
the literature — so models are an upgrade path, never a dependency.

---

---

*Extracted from the planning document (2026-10-12/15). Reasoning is kept with each
conclusion deliberately — see [DECISIONS.md](../DECISIONS.md) for the index.*
