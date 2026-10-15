# Evaluation: three scoreboards

## Three separate scoreboards, never conflated

The published labels in both corpora are **LLM-judge generated**; SWE-chat's 100 human-reviewed gold
sessions are *not* distributed. Reporting LLM-judge agreement as precision would violate the project's
own honesty principle. So:

| Tier | Source | Size | What it proves | Reported as |
|---|---|---|---|---|
| **Synthetic** | Hand-authored skeletons, one per label incl. healthy look-alikes | ~25 | Detector logic fires on the shape it targets | unit tests — never a precision number |
| **Silver** | Published LLM-judge labels (SWE-chat pushback/intent, `misalignments.json`) | 1000s | Broad agreement with the literature | "silver agreement," explicitly labeled |
| **Gold** | Hand-labeled by us from real SWE-chat Claude Code trajectories | 30–50 | **Real precision/recall** | the headline number |

`agentsensei eval` prints all three in separate blocks with the tier named. This is what makes M4 possible
immediately rather than in three weeks, while keeping the trustworthy number honest.

**Fixtures ship as JSONL, not Parquet.** `eval` is a shipped command, so whatever format the gold and
silver sets live in would put that reader in the distributed tool. The derived windows are therefore
converted to JSONL and committed to the repo (with `NOTICE` attribution — ODC-BY/CC-BY/MIT all permit
redistributing derivatives). Parquet is read exactly once, during fixture extraction, and stays a
dev-only dependency that never reaches the runtime path.

---

---

*Extracted from the planning document (2026-10-12/15). Reasoning is kept with each
conclusion deliberately — see [DECISIONS.md](../DECISIONS.md) for the index.*
