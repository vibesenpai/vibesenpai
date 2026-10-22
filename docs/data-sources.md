# Data sources, corpora & licences

## Primary data source: SWE-chat

[`SALT-NLP/SWE-chat`](https://huggingface.co/datasets/SALT-NLP/SWE-chat) (EMNLP/COLM 2026, Stanford)
is close to a purpose-built fixture corpus for this project:

- **17,968 real sessions**, 229k user prompts, ~2M tool calls, from real users on real repositories
- **~69% is Claude Code** — the exact harness M1 targets — plus Codex, Cursor, Gemini CLI, Copilot CLI, OpenCode, Pi, Factory Droid
- **Real human messages.** Users push back in 45.7% of turns and interrupt in 4.5% — the signal the
  SWE-bench-style trajectory datasets structurally lack (single instruction, then autonomous)
- Ships `conversations`, `session_logs`, `checkpoints`, `commits`, `context_events`,
  `subagent_tasks`, `skill_invocations` tables; interrupts appear as `queue_operation` rows with
  subtypes (`user_prompt_enqueued` / `_delivered` / `_discarded`)
- PII removed with Microsoft Presidio; credentials scanned with TruffleHog; Stanford IRB exempt; opt-in consent

Access caveats to settle at download time: the HF dataset card is **gated** (requires an HF login and
sharing contact info) and states **ODC-BY**, while the paper states CC BY 4.0. 47 GB total, so pull only
the `conversations` config filtered to `agent == "claude-code"`, not the whole corpus. Gating means a
one-time authenticated download during development — it does not affect the shipped tool, which stays
offline by default.

**Supporting corpora**

- [`ND-SaNDwichLAB/coding-agent-misalignment`](https://github.com/ND-SaNDwichLAB/coding-agent-misalignment)
  (MIT) — the replication package for *How Coding Agents Fail Their Users* (20,574 sessions). Ships
  `misalignments.json` with labeled episodes from permissively licensed repos. Raw traces are
  deliberately not redistributed; they are re-obtained from SWE-chat.
- [`PatronusAI/TRAIL`](https://huggingface.co/datasets/PatronusAI/TRAIL) (MIT, Parquet, 148 traces /
  841 human-labeled errors over GAIA + SWE-Bench Lite). Genuinely human-annotated, but no human turns —
  useful for tool-loop detection only. Deferred to M4.

---

## Adopt the published taxonomy instead of inventing one

*How Coding Agents Fail Their Users* provides a validated taxonomy (LLM-judge accuracy 0.81 vs expert
gold; human inter-rater agreement 0.83; extraction precision 0.93). Aligning to it is what "industry
standard" means here, and it surfaces two high-prevalence failure modes the original doc missed.

| Published symptom | Prevalence | Original doc label |
|---|---|---|
| S3 Developer Constraint Violation | 38.3% | `constraint_decay` |
| S2 Misread Developer Intent | 27.0% | — (partly `clarification_churn`) |
| **S7 Inaccurate Self-Reporting** | **22.6%** | **missing** |
| S5 Faulty Implementation | 17.8% | implied by `rework_loop` |
| S1 Wrong Project Diagnosis | 11.6% | — |
| **S4 Self-Initiated Overreach** | **10.2%** | **missing** |
| S6 Operational Execution Error | 2.9% | — |

Causes (C1 Underspecified Instruction 15.4%, C3 Premature Action 11.1%, C4 Context Loss 4.3%,
C5 Default-Driven Override 2.4%) map onto `clarification_churn`, reading-before-acting, and
`constraint_decay` respectively.

Also relevant: 91.5% of resolved episodes required explicit user correction — meaning user-correction
language is the highest-yield detector signal, and worth building first.

---

## Existing parsers: reuse is permitted, and one solves our hardest problem

Per §4.1 of the design doc. All three are **MIT**, so reuse and adaptation are permitted with
attribution. Verified via the GitHub API on 2026-10-12.

| Project | Stars | Language | License | Verdict |
|---|---|---|---|---|
| [`jhlee0409/claude-code-history-viewer`](https://github.com/jhlee0409/claude-code-history-viewer) | 2,241 | **TypeScript** | MIT | **Adapt its parser.** Code search shows 21 `parentUuid` and 32 `isSidechain` references — it has already solved the tree reconstruction and sidechain attribution that schema corrections #1 and #2 below identify as the main false-flag risks. Same language, permissive license, pushed today. |
| [`kenn-io/agentsview`](https://github.com/kenn-io/agentsview) | 6,093 | Go | MIT | No direct code reuse (Go). Study its SQLite indexing design for M3 — it indexes once rather than re-parsing per run. Also the **closest competitor**: "local-first session search, analytics, insights." Our differentiation is diagnosis and coaching, not search and token counting — worth a hard look at its feature set before M2 to confirm that gap is real. |
| [`androidZzT/cc-statistics`](https://github.com/androidZzT/cc-statistics) | 116 | — | MIT | Reference only; volume statistics, which is explicitly not our angle. |

**Action for M0:** read the history-viewer's parser before writing ours, and record in `DECISIONS.md`
which parts are adapted vs written fresh. Attribution and the MIT notice ship in `NOTICE`. Note that
its 2,241 stars and today's push mean it is actively maintained — adapting a snapshot is the plan, not
taking a dependency on it.

---

---

*Extracted from the planning document (2026-10-12/15). Reasoning is kept with each
conclusion deliberately — see [DECISIONS.md](../DECISIONS.md) for the index.*

## Is the corpus too small? No — the remaining signal is not structural

Checked 2026-10-20, because "we are missing things for lack of data" is the
obvious explanation and it turns out to be the wrong one.

**[How Coding Agents Fail Their Users](https://arxiv.org/abs/2605.29442)**
(arXiv 2605.29442) analyses **20,574 real sessions** from 1,639 repositories —
18× this project's corpus — and is the source of the dimension table in
`PLAN.md`. The frequencies match exactly: S3 Developer Constraint Violation
38.33% = our `constraint_decay` 38.3%; S7 Inaccurate Self-Reporting 22.58% =
our `inaccurate_self_report` 22.6%; S4 Self-Initiated Overreach 10.20%.

The decisive sentence is about method, not size:

> Detection relied on developer correction or pushback visible in the chat
> logs, **not on structural signals such as tool-call errors, exit codes, or
> test failures.**

They used GPT-5.4 to extract episodes bottom-up, a second LLM pass to filter
unsupported claims, and an LLM judge for the codebook — 0.93 precision against
two human experts, 0.83 inter-rater agreement.

So the seven misalignment types are **not reachable from structure at any
corpus size**. This project already proved that the hard way:
`inaccurate_self_report` is their S7, was built here on rules, and died **0 true
positives against 5 false positives** (see `GRAVEYARD.md`).

Two conclusions:

1. **More sessions will not produce more structural detectors.** They confirm
   rare ones and give a second population. The honest frontier is the semantic
   tier, which this project has always planned and has not reached.
2. **The signal the paper actually uses is developer pushback** — 91.49% of
   resolved episodes involve explicit user correction. That is `user_correction`,
   which is blocked here by one parser constant: `summarise(s, max = 200)` in
   `src/parsers/claude-code.ts` truncates **45% of user prompts**, discarding
   5.9M characters across 400 sessions.

## A second corpus, if one is wanted

**SpecStory** — 14,789 of the paper's sessions, from 1,441 GitHub repositories,
exported as timestamped Markdown under `.specstory/history/`. A different
population from SWE-chat (IDE as well as CLI) and a different format, so it
would need its own parser behind the existing factory. Worth it for a second
population, not for unlocking structural detectors.

## The paper's pipeline, and where ours differs

Read 2026-10-20 from the replication package
([ND-SaNDwichLAB/coding-agent-misalignment](https://github.com/ND-SaNDwichLAB/coding-agent-misalignment)),
after our judge scored **10–14% silver agreement** against their labels.

### Their three stages against ours — resolved, and they were right

This section used to ask why our recall was low and point at the structural
difference. The answer is in: **adopting the split took session-level agreement
from 129/232 to 165/232**, and the paper's wording took it from 104/232 to
129/232 before that. The diagnosis the section opened with was correct.

| | theirs | ours, now |
|---|---|---|
| stage 1 | **extract** a free-form narrative episode | same — `renderExtract`, no dimension offered |
| stage 2 | **validate**, filtering unsupported records | a ~2% mechanical guard, not their 46% funnel |
| stage 3 | **annotate** with S1–S8 on a validated episode | `renderLabel`, reasoning before the label |
| anchor | a **direct quotation** | same — a quote, with the turn derived from it |
| trigger | "only when it surfaces through subsequent developer **correction or pushback**" | deliberately not adopted — see below |
| input | the full formatted session | the full merged session, **plus tool calls and results** |
| model | GPT-5.4 | Haiku (measured better than Sonnet here, at 1/18 the cost) |

**The taxonomy is applied last, not first.** Their extractor never sees S1–S8; it
is asked only to find episodes where "the collaboration broke down" and write
them up. Classification happens afterwards, against a record already confirmed
to be real. We now do the same, and the dimension hardest to pick while reading
— `misread_intent` — more than doubled as a result (28 → 64 of 147).

### Where we are deliberately wider, and it is the biggest one

**Their formatter carries no tool calls and no tool results.**
`session-formatting/format_sessions.py` handles `role` and text only. That is why
`invisible_agent_action` is their largest rejection category at 4,910 of 13,778 —
their judge cannot tell whether the agent executed anything, so "it said it ran
the tests but didn't" is unverifiable for them.

Our packet renders `[Bash] <cmd>` and `[result ok|FAILED] <output>`. **The single
largest source of their false positives is a limitation we do not have**, which
also means some of their 13,778 rejected records — and some of the 319 sessions
they marked clean — may be real.

**And their 46% rejection rate is not a quality signal.** Decomposed: 17.9% is
their push-back trigger (a scope decision we do not share), 26.6% is data their
transcripts lack, and only **1.6% is genuine extractor error**. Porting their
validation wholesale would have imported limitations we do not have and
discarded findings we want.

**Correction is the definition, not a hint.** Their prompt scopes misalignment
to what "surfaces through subsequent developer correction or pushback visible
in the conversation", and explicitly excludes work the agent chose to do on its
own. Our rubric describes each dimension in the abstract, which is a far weaker
thing to search for.

**Quotes anchor, turn numbers do not.** Every record must carry a verbatim
quote. A quote is self-validating — it is either in the transcript or it is
not. A turn number is a second numbering the model has to track, and every
"hallucination" we saw turned out to be a citation error rather than an
invented claim.

### What else the package gives us

`data/core/session_mapping.json` covers all 20,574 sessions their pipeline
processed, so a session with no episode is a **labelled negative** rather than
one nobody looked at. Against our corpus:

```
  processed by their pipeline   565 of our 1,140
    with >=1 labelled episode   246   (492 episodes; 437 in-scope, 55 S1/S5/S6-only)
    with none found             319   <- labelled negatives
```

Those 319 are what we could not previously get: a judge finding there is a
genuine false-positive candidate. Until now "unmatched" could always have been
an episode the paper missed.
