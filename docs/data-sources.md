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
