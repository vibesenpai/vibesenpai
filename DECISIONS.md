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
| D7 | Name `agentsensei`; plugin namespaced `/agentsensei:*` (bare `/sensei` is impossible from a plugin — verified against 3 official plugins). *Superseded by D68.* | [docs/distribution.md](docs/distribution.md) |

## Principles

| # | Decision | Evidence |
|---|---|---|
| D8 | **Principle Zero: a broken analyzer must never break a session.** Outranks correctness of findings. 8 enforcement points incl. unconditional `exit 0`, timeouts, detached analysis, circuit breaker, kill switch. | [docs/surfaces.md](docs/surfaces.md) |
| D9 | **Principle One: the live surface must never interrupt.** Worst acceptable outcome is an unnoticed nudge. | [docs/surfaces.md](docs/surfaces.md) |
| D10 | **The product never writes the user's harness config.** Silently editing settings is the S4 Self-Initiated Overreach failure the tool exists to detect. `doctor` reports; it does not fix. | [PLAN.md](PLAN.md) |
| D10b | **We never copy transcripts. Nothing of ours outlives the harness's own files.** A transcript can contain a leaked token; copying it would create a second exposure in a directory we chose, with a lifetime we chose — making any resulting breach ours, from data that was not ours to duplicate. The catalog stores only offsets, hashes and paths pointing back at the source. Copying was considered as an opt-in and rejected: the escape hatch would have preserved the copy writer, prune loop, sync-root refusal and `0700` enforcement, which is the complexity the decision removes. Cost accepted: **no history beyond the harness TTL, at all.** | [docs/architecture.md](docs/architecture.md) |
| D11 ⚠ | **Statusline, not hook stdout**, for ambient surfacing. Hook stdout lands in the *model's* context — verified in this session's own transcript. Injecting findings would perturb the session being measured. **SUPERSEDED by D58**: `systemMessage` reaches the user and not the model, so the statusline was removed. The observer-effect reasoning still stands and is why `additionalContext` is still refused. | [docs/surfaces.md](docs/surfaces.md) |
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
| D33 ⚠ | **The Ollama/JUDGE tier is probably deletable** — both its dimensions are entailment questions NLI answers in ~50ms instead of 2–5s. **REVERSED in practice**: the judge is built and is the project's strongest result (165/232 sessions, +26 points over the pre-judge rubric). Not Ollama and not NLI — the local harness CLI running Haiku, batch-only, opt-in, off by default. | [docs/models.md](docs/models.md), [src/judge.ts](src/judge.ts) |
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

## The 2026-10-19 reset

| # | Decision | Where |
|---|---|---|
| D45 | **A detector reads structure; the compiler enforces it.** `DetectorContext.events` is `Omit<Event, 'command' \| 'pattern' \| 'textSummary'>`, so reading text in a detector is a build failure. Reverses the "text may nominate" half of D31: nominating still led to deciding. | [CLAUDE.md](CLAUDE.md), [GRAVEYARD.md](GRAVEYARD.md) |
| D46 | **A harness string may name a finding; never produce one.** The runner applies `labels.ts` after a detector has emitted a valid candidate, so a reworded message costs a label, never a detection. Chosen over pure-structure (no advice possible) and string-decides (the thing being removed). | [src/detect/labels.ts](src/detect/labels.ts) |
| D47 | **The verification family is deleted.** Identifying a test command is irreducibly framework-specific. Cost: `no_verification`, called the most actionable sentence this tool could produce. Accepted knowingly — `src/verify.ts` never produced a finding and was capped at the 20% of sessions that were warm. | [GRAVEYARD.md](GRAVEYARD.md) |
| D48 | **The format has no error codes, but it has an envelope.** All 5,354 failing results are plain strings; the harness nonetheless *frames* its errors. `Event.failureKind` records who rejected a call, derived in the harness-specific parser. Only `tool` is agent waste — reporting the person's own hook would be worse than silence. | [src/parsers/claude-code.ts](src/parsers/claude-code.ts) |
| D49 | **`cache_read` is not a hit rate.** It re-counts the whole prefix per call, so `read/(read+creation)` runs p10 0.901 → p90 0.985 by construction. `cache_creation/output_tokens` is the behavioural metric and spreads 7.5x p90/p50. Caught in review, one step from becoming the lead pillar. **Counts were never the problem — the ratio was** — but counts are ordinary too, so D66 shows them only beside a flag. | [docs/findings-frequency.md](docs/findings-frequency.md) |
| D50 | **An aggregate is not a finding.** A session-wide ratio has no turn to anchor to, so token totals are catalog metadata shown beside findings — never a finding, never a score. Keeps "two outputs, never a third". | [src/detect/index.ts](src/detect/index.ts) |
| D51 | **Voice: what the session cost, with receipts** — not "you made a mistake". Naming a mistake requires knowing intent, which is what produced the false positives. | [docs/dimensions.md](docs/dimensions.md) |
| D52 | **A built dimension is measured by its own detector**, never by a probe that resembles it. The loose `tool_loop` probe said 4% of sessions where the detector found 0.4%. `scripts/` is now under the typechecker, which it was not. | [scripts/measure-dimensions.ts](scripts/measure-dimensions.ts) |
| D53 | **`core` membership is about precision, not frequency.** The three detectors that led `core` on assumed frequency were the ones deleted; `redundant_call` fires on 0.4% and earns its place by never being wrong. | [docs/dimensions.md](docs/dimensions.md) |

| D54 | **The ambient layer installs via `settings.json`, not a plugin manifest.** A merge needs no packaging and let the surface be judged on a real machine today. Cost, recorded: absolute paths to the checkout, so moving the repo breaks the hook until re-install. | [docs/surfaces.md](docs/surfaces.md), [src/install.ts](src/install.ts) |
| D55 | **Nothing of the user's config is written without `--apply`**, after a printed diff that also names what is left alone, with a backup and a verify-or-restore. `--print-only` emits **fragments to merge**, never a replacement file — printing the whole merged file would invite pasting over the original and defeat the merge guarantee by following our own instructions. | [src/cli.ts](src/cli.ts) |
| D56 | **An existing statusline is never taken over.** It is a single slot, and a terminal prompt someone built is not ours to replace; the CLI reports the refusal rather than working around it. | [src/install.ts](src/install.ts) |
| D57 ⚠ | **A nudge is scoped to the session it is about.** Two windows share one archive, so an unscoped pick showed one session a finding about another's turns. **The cited file is gone** — `src/queue.ts` went with the statusline (D58). The rule survives it: `src/report-line.ts` scopes by the session id the hook payload carries. | [src/report-line.ts](src/report-line.ts) |

| D58 | **The report renders via `systemMessage` at `SessionStart`, and the statusline is removed.** Reverses D-era "statusline only": `systemMessage` reaches the user and not the model, so the observer effect that drove that choice does not apply. Evidence is Anthropic's own plugins, which contradict their own skill doc. **Never `additionalContext`** — it reaches the model too. | [docs/surfaces.md](docs/surfaces.md), [src/report-line.ts](src/report-line.ts) |
| D59 | **Each detector has a defined display per level.** L1 session start is terse and capped at two dimensions; L2 `now`/`standing` carries evidence and advice. File churn never reaches L1 — 15% correlation against a 9% base rate is orientation, not news. | [docs/dimensions.md](docs/dimensions.md) |
| D60 | **Install clears a statusline the previous version set.** An upgrade otherwise leaves the harness running a deleted script on every render. Found on a real machine in exactly that state. | [src/install.ts](src/install.ts) |

| D61 | **`/agentsensei` is a command file, not a plugin.** `.claude/commands/*.md` with an embedded `` !`cmd` `` shell line gives a working slash command with no packaging. The body demands verbatim output — a summary of evidence is not evidence. | [src/install.ts](src/install.ts) |
| D62 | **The cost line appears only when unusual, as a sentence.** A cache-creation-to-output ratio is meaningful only against other sessions, so below threshold it reported "normal" every session, and the metric's own author could not read it. Presence is now the signal. **Superseded by D66:** the p90 cut was a percentile, which flags 10% of anything; the line now speaks only of rebuilds. | [src/report-line.ts](src/report-line.ts) |
| D63 | **The report names the worst file.** "4 edits" with no subject drew the question "4 *what* edits?" from its first reader. One name, plus a count of the rest, keeps the block a fixed height. | [src/standing.ts](src/standing.ts) |
| D64 | **The plugin is the only front door; the `settings.json` installer is deleted.** Reverses D54 and D61. `/plugin install` declares hooks and commands from the manifest, so the 585 lines that merged entries into `~/.claude/settings.json` served a path nothing reached — and deleting them removes the project's *only* code that writes the user's config, which is stronger than a rule against misusing it. The CLI survives as the engine the plugin invokes; it is never typed by a human. Found during a verification pass: the rename to `:session` left `now.md` installed and broken, because the installer rotted unwatched. | [GRAVEYARD.md](GRAVEYARD.md) |
| D65 | **Dismissing hides; it never deletes.** Rule findings are re-derived from transcripts every pass, so a deleted one returns at the next session start. A `dismissal` table records ids and enums only. Scope differs by tier: a rule finding by `subjectId` (stays gone across sessions, per D25), a judge finding by occurrence (its subject is its dimension, so by subject would be a mute). *Clear all* records per-session finding ids, so a subject that recurs later still shows. `wrong` leaves every count; `noise` and `cleared` were real. The judge still reads dismissed findings, or it would report the same episode again under a new id. Every surface that shrinks says how many are dismissed. | [src/dismiss.ts](src/dismiss.ts) |
| D66 | **Cache numbers appear only beside something abnormal.** agentsensei is not a usage counter: plain totals are ordinary, sums are dominated by the longest session, and the hit rate is mechanical (median 99.7% across one machine's 41 model findings, every dimension 99.5–99.8%). A **rebuild** — the prefix thrown away and written again — is abnormal by kind, so it is flagged `!` with its turn, the gap and what was written; the live line states it in words with no mark. Compaction-led collapses are not rebuilds (10 of 48 on one machine). A no-gap rebuild flag and a long-carried-result flag were measured and dropped: 1 case, and legitimate reads. | [docs/dimensions.md](docs/dimensions.md) |
| D67 | **A judged finding gets its own fix, built from its evidence; the dimension's fix is the fallback.** A per-dimension line can be copied into any CLAUDE.md, and this repo's own rules file held exactly those lines. The fix is parameterised from what the judge stored and the transcript read in place: a forbidden command becomes a `permissions.ask` entry, a write outside the project a `PreToolUse` guard on that path, a broken loaded instruction a request for a test, an earlier expectation a rule scoped to the files written in spite of it. **Deterministic first**; text is read only to fill in a finding that exists. Precision gates measured on one machine's 63 findings: matching a command to any word of the quote gave 11 junk of 12; a negated mention gave 1 of 1. The anchoring quote is usually the reaction ("that didn't work"), so a rule comes only from a lookback-verified earlier turn: 5 of 63 findings get their own fix, plus one shared fix over 5. The id keys on what the fix is for (`action:git push`), so two constraints in one dimension no longer collide, and its outcome counts that constraint. Mechanism facts checked against code.claude.com on 2026-11-01. The Stop hook's test command is not picked by us (D47); it stays printed. | [docs/artifacts.md](docs/artifacts.md#a-fix-per-finding) |
| D68 | **Renamed to `vibesenpai`; plugin `/vibesenpai:*`. Supersedes D7.** On 2026-10-31 an unrelated account published `agentsensei` to npm as a tool that "coaches you to prompt better": the framing D1 rejects, under our name. A text check on 2026-11-08 found no copying, so there was nothing to report and the npm name was gone. `vibesenpai` keeps the hybrid shape (a tech word plus a Japanese one); it was free everywhere it matters on 2026-11-08. The pitch stays an investigation: *Discover how your agents failed you.* Old fix markers and old judge folders are still recognised, so history carries over. | [docs/distribution.md](docs/distribution.md#name-agentsensei--vibesenpai-2026-11-08) |

| D69 | **The plugin ships as a zip on a tagged GitHub release, and installs are counted from its downloads.** Claude Code gives an author no install count; its public counts cover only `claude-plugins-official` (observed in its stats file on 2026-11-08: 324 plugins, all from that marketplace). A self-hosted plugin's only first-party trace is a download we serve, so `marketplace.json` points at a release zip pinned by `sha256`, and GitHub's per-file download count is the measure. No telemetry and no server: we receive nothing about users, and a changed zip fails to install. A download is a first install or a manual upgrade (auto-update is off for non-Anthropic marketplaces). The install command is unchanged. Open: whether an update check downloads the zip, and what a client older than v2.1.224 does with an `archive` source. | [docs/distribution.md](docs/distribution.md#releases-and-install-counts-2026-11-08) |

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

## D35 — pass/fail is structural; verification is confirmed by behaviour

Two separate questions got conflated under "read the output", and they split cleanly.

**Did this result fail?** Structural only — `is_error`, or a non-zero `exitCode` parsed from the
harness's own `Exit code N` prefix. `Exit code 0` is never emitted, so absence of both is success. No
version gate is needed: harness 1.0 signals failure via `is_error` (33 of 116 Bash results), 2.0 and
2.1 via either.

**The text heuristic it replaced was actively wrong.** It read `0 errors, 0 warnings` as a failure,
which is how `uv run pyright` sat in the registry as `0p/5f` when all five runs were clean. The audit
settled it: in **26 of 38** cases where the harness reported a non-zero exit, a careful text pattern
saw nothing wrong. Text was the worse judge in both directions — and it was a pattern list over an
open space that both nominated and decided, which D31 forbids.

**Is this command verification?** Behaviourally: it produced verdict-shaped output **and ran
immediately after an edit, at least twice**.

The previous rule — "the verdict varied" — is the right definition and a useless test. Measured over
255 sessions it confirmed **0 commands in 0 projects**, because the exit status is masked: agents pipe
test output through `tail` to manage context, and the shell reports `tail`'s status. **111 of 127**
verdict-bearing results are pipelines. The information is not there to recover.

Running after an edit survives piping completely — a pipe mangles the status, not the fact that the
command ran. Candidate rules, measured:

| rule | commands | warm projects |
|---|---|---|
| verdict varied | 0 | 0 |
| ran after an edit >= 1 | 14 | 4 — admits `gh run view`, `# Kill the` |
| **ran after an edit >= 2** | **7** | **3** |

At two cycles the admitted set is `npx vitest run`, `uv run pyright`, `pytest tooling/...`,
`npm run typecheck`, `vitest run`, `tsc`, and one ad-hoc `node` script. Six unmistakable, one
arguable. Verdict shape still **nominates**; behaviour **decides**.

**Effect:** warm projects 1 -> 3, sessions in a warm project 33 of 255, verified edits 0% -> 31%. The
corpus gate now exercises verification end to end, which it previously could not.

**Two things measured and rejected along the way.** The agent's own `TodoWrite` status transitions
looked like a free structured verdict — but where an exit code also existed the two **disagreed 12
times out of 14**, because the agent advances a task that is often unrelated to the failing command.
And `editEvidenceOf` moved to `src/edits.ts` so the registry can use it without a cycle.
