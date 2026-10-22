# Evaluation: three scoreboards

## Three separate scoreboards, never conflated

The published labels in both corpora are **LLM-judge generated**; SWE-chat's 100 human-reviewed gold
sessions are *not* distributed. Reporting LLM-judge agreement as precision would violate the project's
own honesty principle. So:

| Tier | Source | Size | What it proves | Reported as |
|---|---|---|---|---|
| **Synthetic** | Hand-authored skeletons, one per label incl. healthy look-alikes | ~25 | Detector logic fires on the shape it targets | unit tests — never a precision number |
| **Silver** | Published LLM-judge labels (SWE-chat pushback/intent, `misalignments.json`) | 1000s | Broad agreement with the literature | "silver agreement," explicitly labeled |
| **Gold** | Hand-labelled by us, against real trajectories | **0 so far** | **Real precision/recall** | the headline number — and there is no headline number yet |

`agentsensei eval` is not built. The tiering is still load-bearing, because it is what stops the silver
numbers being quoted as precision.

## What this means for the judge numbers, which is the awkward part

The judge is measured against the published labels of
[arXiv 2605.29442](https://arxiv.org/abs/2605.29442) — 246 sessions we hold, 437 in-scope episodes, 557
claims. Those labels are **LLM-extracted with human validation on a sample** (0.93 precision against two
experts on 200 of 16,118 records). By the table above that is **silver**, not gold.

So every judge figure in this repo is **silver agreement**, and must be said that way:

```
  two-stage      165/232 sessions · 290/437 episodes · 175/557 claims
  single-pass    129/232          · 196/437          · 119/557
  old rubric     104/232          · 151/437          ·  96/557
```

**None of that is precision.** It is the rate at which our judge and theirs agree, and the gold set
cannot distinguish "we missed it" from "they labelled something we deliberately exclude" — we dropped
their visible-push-back trigger on purpose, so some disagreement is by design.

The one figure that is closer to precision: on **319 sessions their pipeline examined and found nothing
in**, we report 149 findings. Those are false-positive *candidates*, not confirmed false positives,
because their first pass is 46% false positive by their own measurement and only 1.6% of that is genuine
extractor error — the rest is scope and corpus they lacked. Treat it as an upper bound on our noise.

**There is still no gold tier, and nothing here substitutes for one.**

**Fixtures ship as JSONL, not Parquet.** `eval` is a shipped command, so whatever format the gold and
silver sets live in would put that reader in the distributed tool. The derived windows are therefore
converted to JSONL and committed to the repo (with `NOTICE` attribution — ODC-BY/CC-BY/MIT all permit
redistributing derivatives). Parquet is read exactly once, during fixture extraction, and stays a
dev-only dependency that never reaches the runtime path.

---

*Extracted from the planning document (2026-10-12/15). Reasoning is kept with each
conclusion deliberately — see [DECISIONS.md](../DECISIONS.md) for the index.*
