# Decisions

One line per decision, with a pointer to the document holding its evidence. **The reasoning is the
point** — if a decision gets revisited, read the linked section first; most of these were reached by
discarding a more obvious answer.

Planned 2026-10-12/15, before any code existed.

## Product

| # | Decision | Evidence |
|---|---|---|
| D1 | Two outputs only: **evidence** + **something applicable** (prompt / guard / rule). Never behavioural advice. | [README](README.md#value-proposition) |
| D2 | **No umbrella term** for the three artifact kinds; `fix` is a verb only. ~Half of findings have nothing applicable, so a noun promising one would break that promise. | [README](README.md) |
| D3 | **Problems lead, strengths follow.** Burying cost under praise reads as evasive. Strengths get real billing, second. | [docs/surfaces.md](docs/surfaces.md) |
| D4 | **Running score on every run** — per-dimension deltas vs the previous window and all time. Reframes "proves improvement" from a weeks-long promise into an always-present tally. | [docs/surfaces.md](docs/surfaces.md) |
| D5 | Target audience: **strangers running `npx`**. Teams later, with cloud. | [PLAN.md](PLAN.md#target-audience) |
| D6 | **The harness is the primary surface**, not the CLI. `/plugin install` → `/agentsensei:*`. The CLI is for CI and pre-install trial. | [docs/surfaces.md](docs/surfaces.md) |
| D7 | Name `agentsensei`; plugin namespaced `/agentsensei:*` (bare `/sensei` is impossible from a plugin — verified against 3 official plugins). | [docs/distribution.md](docs/distribution.md) |

## Principles

| # | Decision | Evidence |
|---|---|---|
| D8 | **Principle Zero: a broken analyzer must never break a session.** Outranks correctness of findings. 8 enforcement points incl. unconditional `exit 0`, timeouts, detached analysis, circuit breaker, kill switch. | [docs/surfaces.md](docs/surfaces.md) |
| D9 | **Principle One: the live surface must never interrupt.** Worst acceptable outcome is an unnoticed nudge. | [docs/surfaces.md](docs/surfaces.md) |
| D10 | **The product never writes the user's harness config.** Silently editing settings is the S4 Self-Initiated Overreach failure the tool exists to detect. `doctor` reports; it does not fix. | [PLAN.md](PLAN.md) |
| D10b | **We never copy transcripts. Nothing of ours outlives the harness's own files.** A transcript can contain a leaked token; copying it would create a second exposure in a directory we chose, with a lifetime we chose — making any resulting breach ours, from data that was not ours to duplicate. The catalog stores only offsets, hashes and paths pointing back at the source. Copying was considered as an opt-in and rejected: the escape hatch would have preserved the copy writer, prune loop, sync-root refusal and `0700` enforcement, which is the complexity the decision removes. Cost accepted: **no history beyond the harness TTL, at all.** | [docs/architecture.md](docs/architecture.md) |
| D11 | **Statusline, not hook stdout**, for ambient surfacing. Hook stdout lands in the *model's* context — verified in this session's own transcript. Injecting findings would perturb the session being measured. | [docs/surfaces.md](docs/surfaces.md) |
| D12 | Banned with no fallback: `UserPromptSubmit` surfacing, `/dev/tty` writes, OSC codes, terminal bell, mid-session notifications. | [docs/surfaces.md](docs/surfaces.md) |

## Dimensions

| # | Decision | Evidence |
|---|---|---|
| D13 | **40 dimensions**, grounded in 5 published taxonomies rather than invented. | [docs/dimensions.md](docs/dimensions.md) |
| D14 | Weighted by **real prevalence**, not by how interesting they sound: `constraint_decay` 38.3% ≫ `rework_loop` 17.8%. | [docs/dimensions.md](docs/dimensions.md) |
| D15 | **`core` preset is all pure rules** (9 dimensions). "Zero required dependencies for value" is an adoption requirement, not an aesthetic. | [docs/dimensions.md](docs/dimensions.md) |
| D16 | **`ambient` is a separate, much shorter list** than what gets computed. This is the main anti-nag control — enabling `all` must not make the tool noisy. | [docs/dimensions.md](docs/dimensions.md) |
| D17 | Confidence ceiling is **~0.85, not 1.0**, for subjective dimensions — human inter-rater agreement is 0.83. Only deterministic dimensions approach 1.0. | [docs/dimensions.md](docs/dimensions.md) |
| D18 | Healthy patterns are **credited as strengths**, not merely withheld. They are also each problem dimension's precision defence. | [docs/dimensions.md](docs/dimensions.md) |

## Intervention

| # | Decision | Evidence |
|---|---|---|
| D19 | **"Add a CLAUDE.md line" is a weak intervention** — 3.6% of the compliance gap vs 10.2% for tool-backed enforcement (753 rules, 410 repos, p=0.022), and 66.7% of existing rules are ceremonial. | [docs/artifacts.md](docs/artifacts.md) |
| D20 | Artifact kinds ranked by measured effect: **GUARD → PROMPT → MEMORY → REPORT**. | [docs/artifacts.md](docs/artifacts.md) |
| D21 | `PreToolUse` guards **prevent**; `Stop` guards **catch and correct**. Only the first is a guarantee — an earlier draft overclaimed this. | [docs/artifacts.md](docs/artifacts.md) |
| D22 | **`CLAUDE.md` is a budget, not a log.** `claude-md` audits rules as ceremonial / ineffective / working — possible only because we hold before-and-after violation data. | [docs/artifacts.md](docs/artifacts.md) |
| D23 | A **guarded dimension is suppressed, not improved.** Conflating them would be the tool flattering itself. | [docs/surfaces.md](docs/surfaces.md) |

## Contracts

| # | Decision | Evidence |
|---|---|---|
| D24 | Evidence refs use **`uuid`, never position**. `seq` is a position on the active leaf path and silently shifts after a rewind. | [docs/contracts.md](docs/contracts.md) |
| D25 | **Two identity keys**: `findingId` (per session) and `subjectId` (per project, across sessions). The score, dismissals, and the audit all need the second. | [docs/contracts.md](docs/contracts.md) |
| D26 | The **skeleton is versioned**, and `v` is in the verdict cache key — three consumers (model input, user-facing evidence, future team wire format). | [docs/contracts.md](docs/contracts.md) |
| D27 | Skeletons are **redacted at construction**, built as if they will be transmitted. Also what makes the eval fixtures safely redistributable. | [docs/contracts.md](docs/contracts.md) |
| D28 | **Events are not stored** in SQLite — re-derived from the source via the incremental catalog. Search is not our product, so the trade goes opposite to `agentsview`. | [docs/contracts.md](docs/contracts.md) |
| D29 | **Store in XDG, models in `$CLAUDE_PLUGIN_DATA`.** The store holds the catalog and findings — derived, redacted, and worth keeping across a plugin uninstall; models are large and re-downloadable. | [docs/models.md](docs/models.md) |
| D30 | Detectors are **`async` from day one**; findings carry `method` / `confidence` / `modelVersion` even while all are `RULE` / `certain` / null. | [docs/models.md](docs/models.md) |

## Models

| # | Decision | Evidence |
|---|---|---|
| D31 | **NLI cross-encoder decides; embeddings only shortlist.** Cosine cannot distinguish `npm` from `pnpm` in a constraint check — it measures topic, not logical relation. | [docs/models.md](docs/models.md) |
| D32 | Stack: **EmbeddingGemma-300m** (175MB q4f16, #1 MTEB <500M) + **nli-deberta-v3-base** (~90MB, 92.38% SNLI) + bundled SetFit heads. ~270MB. | [docs/models.md](docs/models.md) |
| D33 | **The Ollama/JUDGE tier is probably deletable** — both its dimensions are entailment questions NLI answers in ~50ms instead of 2–5s. | [docs/models.md](docs/models.md) |
| D34 | **Hooks never download.** Ever, under any config. Diverges from mem0 deliberately: its plugin is useless without its SDK; all of our `core` works without models. | [docs/models.md](docs/models.md) |
| D35 | Download concurrency uses an **atomic `mkdir` lock + stamp file + failure sentinel**, adopted from mem0's `ensure_deps.sh`. Two sessions starting at once would otherwise both fetch 270MB. | [docs/models.md](docs/models.md) |
| D36 | Naming: artifact is **"models"**; capability is **"semantic analysis"**. "Classifiers" mislabels the 175MB embedder, which classifies nothing. | [docs/distribution.md](docs/distribution.md) |

## Evaluation

| # | Decision | Evidence |
|---|---|---|
| D37 | **Three scoreboards, never conflated**: synthetic (unit tests), silver (published LLM-judge labels), gold (hand-labelled). Only gold is quoted as precision. | [docs/eval.md](docs/eval.md) |
| D38 | Gold data comes from **SWE-chat** (17,968 real sessions, 69% Claude Code, real human pushback) — not from waiting weeks for local data. | [docs/data-sources.md](docs/data-sources.md) |
| D39 | **`rework_loop` ships un-trusted**: in the MVP but out of `core` and `ambient` until `eval` measures it. | [PLAN.md](PLAN.md#mvp-scope) |

## Distribution

| # | Decision | Evidence |
|---|---|---|
| D40 | **Not the official/partner marketplace.** Target the Anthropic **community** marketplace (automated security scan, not partnership) plus self-hosting. | [docs/distribution.md](docs/distribution.md) |
| D41 | **Self-host from day one** — no gatekeeper, works the day the repo is public. Submit to the community marketplace once precision is measured. | [docs/distribution.md](docs/distribution.md) |
| D42 | The plugin **bundles the analyzer**; npm is never required for normal use. | [docs/distribution.md](docs/distribution.md) |
| D43 | Reuse the MIT-licensed [`claude-code-history-viewer`](https://github.com/jhlee0409/claude-code-history-viewer) parser — it already solves `parentUuid` tree reconstruction and sidechain attribution. | [docs/data-sources.md](docs/data-sources.md) |

## Reversed or corrected during planning

Kept because the discarded answer is the one a reader will reach for next.

| Was | Became | Why |
|---|---|---|
| "Fully local" and "cross-harness" are differentiators | Neither is | Every competitor is local; agentsview covers 20+ harnesses to our 1 |
| Coaching layer with behaviour-change loop | Artifacts, no advice | Advice is the weak, crowded half; a generated hook is not advice |
| `CLAUDE.md` line as the flagship fix | A guard is ~3× better; `MEMORY` is budget-limited | The 753-rule study |
| `all-MiniLM-L6-v2`, lazy ~23MB download | EmbeddingGemma + NLI, eager ~270MB | Size stopped being the constraint; accuracy and negation handling did |
| `post_compaction_drift` | `context_rationale_erosion` | The published version names *why* the decision reversed |
| Copy every transcript into our own archive | Catalog only — copy nothing | Mirroring the harness TTL removed the benefit; duplicating a leaked token would make the breach ours |
| Mirror `cleanupPeriodDays` and prune copies | No copies, so nothing to prune | The pruning machinery only existed to manage a copy that should not exist |
| `turn: number` as the event index | `uuid` + reconstructed leaf path | Transcripts are a tree |
| Measured before/after as a headline differentiator | A running score on every run | The headline version needs weeks and asks for belief |
| Strengths lead the report | Problems lead | Burying cost reads as evasive |
| 6 MVP dimensions | 13, outcome-aware | Detector count is not the cost driver; the parser and plumbing are |

## Dev-environment actions (explicitly outside product behaviour)

| Action | Note |
|---|---|
| `cleanupPeriodDays: 3650` on the development machine | One-time, on request, to stop transcript loss during development. **The product never does this.** |

## D31 — verification is discovered, not configured

**Decision:** no hardcoded framework list and no required user config. A command is verification when
it executed, its output reports a verdict, and — for anything that produces a finding — its verdict has
been observed to vary. Learned per project and persisted; user config is an override.

**Why the obvious design was discarded.** A list plus a config field was built first. It is wrong on
its face: there are thousands of toolchains, so the detector's accuracy would track how well the
author guessed the user's stack. Measured on a public corpus, a hand-written list missed `mise run`,
`bun run` and `go build` — most of what those repos actually ran.

**Evidence.** Output-shape matching alone found 108 candidates across 253 sessions, but included
`Read` of a test file, `grep expect(`, `cat >> test.ts` and `WebFetch` of a page about testing —
reading a test looks exactly like running one. Requiring execution and excluding file-writes cut that
to 39 clean candidates, discovering `uv run pyright`, `pytest`, `vitest`, `tsc --noEmit`, `go test`,
`mise run test:ci` and `ruff check` with none of them named. Behavioural confirmation then excluded
`git log --oneline`, which matched shape once and never varies.

**Cost, stated:** a cold start. On the validation corpus 26 of 27 projects were cold, because almost
every "project" there is a single-session fixture directory with no history to confirm from. Real use
accrues confirmation across sessions in the same repo. Until it does, detectors stay silent — which is
the `unknown` beats guessing rule, applied to the question "what counts as a test here".

## D32 — detector scope is per-detector, and the window is only a token budget

**Decision:** `Scope = 'window' | 'thread' | 'session' | 'project'`, declared by each detector. The
runner groups once and dispatches. `project` is declared but refused with a clear error until the
store exists (M3).

**Why:** the first implementation ran every detector per window, conflating "the unit a model can
afford to read" with "the span a rule evaluates". Measured across 255 sessions: of 363 genuinely
verified edits, **293 (81%) are verified by a command in a later window** — a per-window
`no_verification` would call all of them unverified. A precision failure, not a recall one.

**A misleading measurement, recorded so it is not repeated:** counting "runs of >=3" per window versus
per session showed *more* per window, which looked like windows were fine. Wrong metric — splitting
one 7-call run into 4+3 raises the count while destroying the information.

**Why `thread` exists separately from `session`:** a flat session array interleaves subagent events
among main-thread ones, so anything about *consecutive* events is wrong on it. `tool_loop` is the only
current detector where locality is the signal. Conversely `session` is needed because a subagent may
edit the files the main thread then verifies or resets.

## D33 — "did a file change?" is three layers, not a tool list

**Decision:** `tool` (Claude's own writers — a closed, published, four-entry list), then `harness`
(`file-history-snapshot` version increases — tool-agnostic), then `probable` (carries a path, is not a
known reader) which is **counted separately and never treated as a confirmed edit**.

**Why:** `EDIT_TOOLS` was a name allowlist acting as the complete answer in a world where MCP servers
and custom agents add tools nobody publishes. `mcp__acp__Write` is in the corpus, writes files, and
was counted as zero edits.

**Evidence and proportion.** Layer 1 covers 789 of 794 file-writing calls. Layer 2 added 412
harness-recorded changes but is version-gated — 0 of 56 sessions on harness 1.0, 1 of 87 on 2.0, 22 of
the 34 *editing* sessions on 2.1 — so an earlier proposal to make it the single source of truth was
overstated and was corrected. Layer 3 leaves 16 unclassified touches, which `Denominators` reports
rather than folding in.

**No change needed to `didExecute`:** `toolTarget` already ignores tool name and extracts by *field*
(`file_path`/`path`/`notebook_path`, `command`, `pattern`/`query`) — a closed, conventional space.
Verified: `mcp__acp__Bash` yields `command: "bunx tsc --noEmit"`, so verification discovery already
reaches MCP tools.

## D34 — `inaccurate_self_report` is `high`/`LEX`, not `certain`/`RULE`

**Decision:** demoted from `certain` to `high`, and relabelled `RULE` to `LEX`.

**Why:** its claim detection is lexical over an open space — every way a person can phrase success —
and the patterns both *nominate* and *convict*, with nothing behavioural confirming them. That fails
the allowlist rule (D31's corollary: a list over an open space may only nominate). The structural
half — a failing verification immediately preceding the message — is genuinely certain; confidence has
to track the weakest link. `CLAUDE.md` also forbids blurring "flagged by rule" with "flagged by a
lexical guess".

It stays in `core`, which admits `certain` or `high`. M2b's outcome signal ("did a correction
follow?") is the behavioural decider that could raise it back.
