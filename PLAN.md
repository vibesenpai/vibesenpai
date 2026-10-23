# Implementation plan

## Target audience

**Strangers running `npx`.** Individual developers using Claude Code, who have never heard of this
and will give it one run to prove itself. Teams later, once cloud support and the surrounding
machinery exist.

That makes the positioning analysis in this document load-bearing rather than context, and it sets
five hard constraints:

1. **Day-one value with no setup.** One `npx` invocation must say something true and useful. No
   account, no model download, no config file, no waiting. This is why `core` is deliberately all
   pure rules — "zero required dependencies for value" is an adoption requirement, not an aesthetic.
2. **The precision bar is brutal.** A stranger who gets one false flag uninstalls permanently and
   never tells you why. This is the strongest argument for gating `rework_loop` out of `core` and
   `ambient` until `eval` measures it, and for `unknown` suppressing rather than guessing.
3. **Never-interrupt is non-negotiable.** A tool that annoys someone on day one is gone by day two.
4. **Cross-harness matters for reach** — but Claude Code still ships first: it is the largest harness
   and 69% of the SWE-chat corpus, so it is also where the eval data is.
5. **Honest empty states.** "Nothing found" must read as a clean bill of health, not a broken tool.

### The cold start is far better than this machine suggests

One correction worth carrying: **this development machine is pathological, not typical.**
Claude Code's 30-day retention wiped everything here because the tool saw almost no use between
August and October, leaving 2 trivial transcripts. **A typical active Claude Code user has up to 30
days of sessions sitting on disk right now** — dozens of them.

So `npx agentsensei` on a normal machine has real data immediately, and the first run is a genuine
report rather than an empty shell. The implications:

- **Day-one value comes from their actual sessions**, not just the `CLAUDE.md` audit. The audit stays
  in the MVP, but as a strong second rather than the sole cold-open.
- **There is no way to recover what the harness already deleted**, and we do not pretend otherwise.
  We read in place and keep no copies, so the honest pitch is "start now and you will have history
  from here" — not "we can rescue your past.
- **The empty case still needs handling well** — a brand-new install, or a machine like this one. It
  must say *"no sessions found yet — here's what will happen as you work"*, never a bare zero.

### Teams later: what that demands of v1

Teams need aggregation, which needs transmission, which collides with local-first. The bridge already
exists on this project's own original terms — *any future sync is explicit opt-in and sends only redacted
skeletons, never raw code* — and that has a consequence worth building for now:

**The skeleton is the future team product's wire format.** It should be designed as if it will be
transmitted, even though in v1 it never leaves the machine: fully redacted, no file contents, no
absolute paths, no identifiers. Getting that right in M1 is what makes a team product possible later
without re-architecting — and getting it wrong means the first sync feature leaks something.

The comparative baseline is also the natural team hook (*"your constraint-violation rate vs your
team's"*), and the published 17,968-session corpus lets us ship the population-relative version of
that to individuals **without** any cloud component at all.
---

## Context

The goal is a local-first, open-source tool that analyzes AI coding-agent sessions and coaches
developers on how they work — detecting rework loops, constraint decay and clarification churn,
with evidence for every finding.

Inspecting the real data on this machine turned up two facts that reorder the originally planned
milestones. Neither is a pivot; both are sequencing changes.

**1. The data substrate is being deleted, and the deletion can resume at any time.**

| | |
|---|---|
| Sessions recorded in `~/.claude/history.jsonl` | 41 (2025-12-26 → 2026-10-12) |
| Transcripts surviving in `~/.claude/projects/` | 2 |
| Usable historical transcripts | **0** (one is the current session; the other is a 3-prompt plugin install) |
| `~/.codex/` | does not exist |

Cause: Claude Code's `cleanupPeriodDays` defaults to 30 days. `~/.claude/.last-cleanup` records a run
at `2026-08-23T03:58Z`, which deleted everything older than ~2026-07-24. It has not run since only
because Claude Code saw little use between August and October. The two richest sessions (346 and 229
prompts) are gone. `cleanupPeriodDays` is confirmed present in the installed build (2.1.296).

`history.jsonl` survives cleanup and holds all 899 prompts across 10 months, but it is prompts-only —
no tool calls, no outcomes. It supports prompt-quality analysis, not loop detection.

**2. Public benchmarks supply what local data cannot.** Rather than waiting weeks for sessions to
accumulate, the eval set is built from published, real-world, permissively licensed corpora — which
is also the stated goal of matching industry standards.

---

## MVP scope — 13 dimensions, outcome-aware

### Where the line is drawn, and why not at a dimension count

Dimension count is **not** the cost driver. Each pure-rule detector is small —
`inaccurate_self_report` is "assertion language + last verification was a failure", roughly 30 lines;
`no_verification` ~25; `tool_loop` ~20. Ten of them is ~350 lines. The real cost is the parser (tree
reconstruction, sidechain attribution), the redactor, the catalog, the CLI and the tests — all paid
once, whether you ship 6 detectors or 16.

So the boundary is drawn at **the dependencies that change the shape of the project.** There are two,
and the MVP crosses exactly one of them:

| Dependency | Cost | In MVP? |
|---|---|---|
| **Outcome classification** (`+OUT`) | test-result parsing, commit detection, convergence logic | **yes** |
| **A model** (`EMB`, `CLS`, `JUDGE`) | lazy download, cache layer, version pinning, eval infra, a new class of failure modes | **no** |

**Why outcome classification is in, despite it being the riskier half.** `rework_loop` is the
catalogue's highest false-flag risk, and the instinct is to defer it. But its discriminator —
`convergent_iteration` — comes from the *same* outcome machinery. You cannot ship rework detection
safely without it, so building the machinery is what makes rework detection safe rather than what
makes it risky. Deferring outcomes would mean either no rework detection at all, or rework detection
with nothing to contradict it. Both are worse.

**Why models stay out.** Crossing into `EMB`/`CLS` is where the project stops being a self-contained
rules engine. It also gates the dimensions whose precision we cannot yet measure, and the design
doc's "zero required dependencies for value" is a real constraint, not a slogan.

### The 13

| # | Dimension | `P` | Conf | What you can apply |
|---|---|---|---|---|
| 1 | `constraint_decay` *(command-shaped only)* | 38.3% | high | guard **+** prompt **+** rule |
| 2 | `inaccurate_self_report` | 22.6% | certain | guard + prompt |
| 3 | `no_verification` | 21.3% | certain | guard + prompt |
| 4 | `premature_external_write` | — | certain | guard |
| 5 | `tool_loop` | 2.9 / 15.7% | certain | prompt |
| 6 | `error_ignored` | top mass | certain | prompt |
| 7 | `revert_churn` | — | certain | report |
| 8 | `user_correction` *(lexical half)* | 45.7% of turns | high | feeds the others |
| 9 | **`rework_loop`** | 17.8% | medium | prompt |
| 10 | **`fail_fix_fail`** | 17.8% | high | prompt |
| 11 | **`convergent_iteration`** | — | high | *strength* |
| 12 | `tdd_fail_then_pass` | — | certain | *strength* |
| 13 | `effective_correction` | — | medium | *strength* |

Plus **`agentsensei claude-md`**, the rules audit. It earns MVP inclusion for a specific reason:
**it is the only output that exists on the first run regardless of session content.** With 13
dimensions many sessions will still produce nothing — correct behaviour, since silence is
information, but a first run reading "nothing found" feels broken rather than clean. The audit is the
anti-empty-report feature, and the constraint extraction it needs is already built by #1.

Coverage: all three artifact kinds, both guard shapes (`PreToolUse` prevents, `Stop` catches), three
strengths, and the three highest-prevalence problems in the literature.

### Outcome classification — and the tri-state that keeps it honest

Outcome is resolved per task window, with **four** states. The fourth is the entire safety mechanism:

| State | Determined by |
|---|---|
| `converged` | verification failure count falls to zero, **or** a terminal pass, **or** the touched files get committed |
| `reverted` | `file-history-snapshot` restoration, or destructive git on files this session touched |
| `abandoned` | session ends with a known-failing state and no commit |
| **`unknown`** | **no verification signal at all, not a git repo, or verification happened outside the session** |

**The rule that makes `rework_loop` shippable: it fires only on `abandoned` or `reverted`. On
`unknown` it does not fire at all.**

This matters more than any threshold in the catalogue. The failure path for rework detection is
treating "we could not determine the outcome" as "it did not converge" — which fires on every project
without tests, every branch left uncommitted, and every developer who runs their tests in a second
terminal. Those are not rework; they are invisibility. Conflating the two produces exactly the false
flag that destroys trust, and `unknown` is what prevents it.

Consequence worth accepting up front: **on repos with no test suite, `rework_loop` is silent.** That
is the correct behaviour and it should be stated in the output (`outcome unknown — no verification
signal in this project`) rather than hidden, so the silence is legible instead of looking like a
clean bill of health.

### New dependency: git and test-result reading

Outcome classification adds scope the rule-only plan did not have:

- **Verification result parsing.** Exit code is the floor; failure *counts* need per-framework
  patterns (vitest, jest, pytest, go test, cargo) and that is a long tail. Start with exit code plus
  a handful of common patterns, and **return `unknown` rather than guessing** on anything
  unrecognised. The tri-state makes a shallow parser safe.
- **Commit detection.** `git log` across the session's timespan, intersected with the files it
  touched. Non-git projects resolve to `unknown`, never to `abandoned`.
- **Convergence logic.** Failure-count monotonicity over a window — the one discriminator that
  separates `convergent_iteration` from `rework_loop`.

### Gating: shipped but not trusted by default

`rework_loop` ships in the MVP and is **not** in `core`, and **not** in `ambient`. It appears in
`report` and `/sensei:now`, never unprompted, until `eval` shows measured precision clearing a bar
against the gold set. The config already supports this — `preset`, `minConfidence`, and the separate
`ambient` list — so the gate is configuration, not a code branch.

This is the compromise that makes including it correct: the detector exists and can be measured from
day one, but it does not get to interrupt anyone until it has earned it.

### Deliberately out of the MVP

- Everything needing `EMB` — `repeated_instruction`, `goal_drift`, `abandonment`
- Everything needing `CLS` — the three `prompt_*` quality dimensions (so `history.jsonl` analysis,
  and with it the 10-month retrospective, lands just after the MVP)
- Everything needing `JUDGE` — `weak_evidence_commitment`, `capability_overcommitment`
- Everything aggregate (`STAT`) — `context_saturation`, `context_hygiene`; they need weeks of data
  before they can say anything
- `context_rationale_erosion` — needs the `PreCompact` capture, which arrives with the plugin
- Group J risk dimensions — off by default regardless
- The dashboard, the measured before/after loop, and Codex support
---

## M0 — preserve, then document

**Hard rule: the product never writes to the user's Claude Code config.** `agentsensei` reads
`~/.claude/settings.json`; it does not modify it, ever. Retention is the user's decision about their
own machine, and a session-analysis tool silently editing a harness config is exactly the kind of
overreach the tool is built to detect (S4 Self-Initiated Overreach, 10.2% of real failures). The
product's job is to *tell* you, not to *fix* you:

```
$ agentsensei doctor
  harness     cleanupPeriodDays not set → Claude Code deletes after 30 days
  store       no transcript copies are kept — sources are read in place
```

This also applies to `agentsensei hooks install` at M6: it prints the exact JSON it would add, asks before
writing, and offers `--print-only` so the user can paste it themselves. Opt-in and visible, never
silent.

*(An earlier plan raised `cleanupPeriodDays` on this machine to stop data disappearing during
development. That is no longer wanted: we read in place and report the harness TTL neutrally rather
than encouraging anyone to keep more data for our benefit.)*

1. **Catalog before parser.** `agentsensei scan` records, per source, the byte offset consumed plus
   size, mtime, sha256 and harness version — and **copies nothing**. A re-scan reads only new bytes;
   unchanged sources cost zero. Everything downstream reads the source in place, from the remembered
   offset.

   **No transcript is ever duplicated.** A transcript can contain a leaked token, so copying it would
   create a second exposure in a directory we chose, with a lifetime we chose — making any resulting
   breach ours. The catalog is 4 KB where copying was 10.4 MB, and the harness's own retention is
   reported but never mirrored, because there is nothing of ours to prune.

   **No hardcoded paths — every location is config-driven with CLI override.** Precedence, highest
   first: CLI flag → env var → config file → platform default.

   | Setting | CLI flag | Env var | Default |
   |---|---|---|---|
   | Transcript sources | `--source <path>` (repeatable) | `AGENTSENSEI_SOURCES` | `~/.claude/projects`, `~/.codex/sessions` |
   | Store location | `--archive <path>` | `AGENTSENSEI_ARCHIVE` | `$XDG_DATA_HOME/agentsensei` |
   | Model location | `--models <path>` | `AGENTSENSEI_MODELS` | `$CLAUDE_PLUGIN_DATA` as a plugin, else `<store>/models` |
   | Config file | `--config <path>` | `AGENTSENSEI_CONFIG` | `$XDG_CONFIG_HOME/agentsensei/config.json` |

   This is what lets the tool work with non-default harness installs, and lets the whole pipeline be
   tested against fixture directories instead of the real home directory.


2. `docs/log-formats.md` — the Claude Code format, **with observed and inferred claims labeled
   separately.** Everything documented so far comes from two local transcripts, and neither contains
   a rewind, a compaction, or a true sidechain (`isSidechain` was present but uniformly `false`;
   `trackedFileBackups` was empty). So the record types, `attachment` noise, content-block nesting
   and retention behaviour are **observed**; the branching tree, sidechain interleaving and revert
   signal are **inferred** — corroborated by the history-viewer's 21 `parentUuid` / 32 `isSidechain`
   references, which M0 cites as the secondary source while reading that parser. The first real
   compaction or `Task` fan-out seen in a real session promotes or corrects each inferred claim.
   Codex marked "not present on this machine."
3. `docs/data-sources.md` — the corpora above with licenses, gating status, and the
   license-compatibility conclusion for redistributing derived fixtures (CC BY / ODC-BY / MIT all
   permit it with attribution; attribution file committed alongside). Plus the parser-reuse verdicts.
4. **Run the two closest competitors on real data** (approved) and write `docs/prior-art.md` from what
   they actually print, not their docs: `vibe-log-cli` and `agentsview`. Note that vibe-log routes its
   analysis through your own Claude Code setup, so this run consumes some of your quota — a one-time
   cost, and a direct demonstration of the differentiator we are claiming. Read the
   `claude-code-history-viewer` parser in the same pass for the reuse verdict.
5. **Split this document** per the mapping above — `README.md`, `docs/*.md`, `DECISIONS.md`, and a
   trimmed `PLAN.md`. Reasoning travels with its conclusion.
6. `DECISIONS.md` + `CLAUDE.md` seeded with the five schema corrections, the three pinned contracts,
   Principles Zero and One, the three-tier eval split, the four surviving differentiation claims, and
   the plan-heavily-implement-smoothly convention.

**M0 is done when:** the catalog tracks every transcript on disk without copying any of them, a
re-scan reads zero redundant bytes, this document is split with no orphaned rationale, and
`docs/prior-art.md` records real output from both competitors rather than claims from their READMEs.

## M1 — parse, redact, skeletonize

1. **Parser** (`src/parsers/claude-code.ts`): JSONL → active-leaf-path reconstruction → content-block
   flattening → `Event[]`. Unknown record types are logged and skipped, never fatal. Sidechains
   attributed separately.
2. **Redactor** (`src/redact.ts`): runs before anything is stored or displayed. API keys, tokens,
   `.env` values, private keys, absolute home paths. Tested first, against deliberately planted
   secrets — SWE-chat's use of Presidio + TruffleHog is the reference bar.
3. **Skeletonizer** (`src/skeleton.ts`): target 5–10% of raw tokens; the originally planned shape is
   the output contract. Measured and asserted in tests — **and the target needed its scope stated.**
   Measured over 223 public transcripts: the aggregate ratio is 1.28%, but that number is flattering,
   dominated by a few very large files. Per file the median is 5.2% and **69 of 223 exceed 10%** —
   all of them tiny fixtures with nothing to strip, the worst being a 0.6 KB file holding a single
   record at 34.9%. For sessions of **≥ 20 events** the target holds with no exceptions: median 1.6%,
   max 6.8%, 0 over 10%. That is the form the gate asserts; the aggregate alone would have hidden the
   shape entirely.

   A *turn* is a skeleton line, not an exchange — settled by the rendered example in
   `docs/contracts.md` (seven lines, two user prompts). Windows do **not** overlap by default:
   `Finding` identity is subject-based so overlap would not duplicate findings, but `occurrences`
   would double-count a turn seen twice until M2a's evidence-set merge exists.

   The elision path does not execute on real data — 12 short lines never approach 2K tokens, and 0 of
   470 corpus windows elided. It is covered by synthetic fixtures carrying an oversized prompt, since
   an untested elision rule is how a skeleton silently drops the decisive turn.
4. **Windowing**: 6–12 turn sliding windows along the active path, sidechains excluded from main-thread windows.
5. **Reader modes** (`src/read.ts`): one incremental offset reader, two modes — `catalogued` (up to
   the recorded offset) and `live` (tails past it for `agentsensei session`). Same code, a parameter.
6. **Pinned contracts** (`src/types.ts`): the three from the Contracts section — `TurnRef` keyed on
   `uuid`, `Finding` with subject-based identity, and the versioned `Skeleton`. These are the only
   shapes specified before implementation, because each one is persisted and would be wrong-in-place
   if changed later.
7. **CLI skeleton**: `agentsensei skeleton <sessionId>`, plus `now` and `report --since/--until/--last/
   --project` wired up to argument parsing and depth labeling, printing "no detectors yet" until M2.
   The shape is settled now because retrofitting it after the detectors exist is the expensive order.

**M1 is done when:** every catalogued session parses without error, the redactor passes its
planted-secret suite, skeletons hit the 5–10% target, and `agentsensei session` reads the in-flight transcript
of the session it is run from — all on local data only.

**Status: done.** Verified on 231 public transcripts and 4 local sessions — 0 crashes, 0 malformed
lines, 0 leaks, and `now` reads the live transcript of the session it is invoked from (8.8 MB, 2,154
events, parser `2.1.241` exact). 193 tests.

Two things the real output corrected, neither predicted by the spec:

- **Empty assistant lines were 21.3% of a tool-heavy session** (3.8% on the public corpus). An
  assistant record with no text renders as a bare `A  …` and carries nothing — its tool calls already
  have their own lines. Dropping it cut 113 windows to 90 on one session.
- **Report depth cannot be a single boundary.** The first attempt used the catalog's earliest
  `firstSeenAt`, which is when *we* looked rather than what the data covers. Fixing that to record
  timestamps then produced the opposite error: local data holds one session on 23 August and three
  from 12 October, and a boundary claimed **49 days of full depth across a September containing no
  sessions**. Coverage is now the union of per-session intervals, so gaps are reported. The `none`
  message also stopped saying "the harness deleted these" — a gap is more often a period nobody
  worked, and before the first scan the two are indistinguishable.

The **SWE-chat adapter** (`src/parsers/swe-chat.ts`, Parquet → the same `Event[]`) moves to **M2**,
where the eval corpus is first needed. This keeps M1 self-contained: it cannot be blocked waiting on
an external gated download, and nothing in its done-criteria depends on data we may not have yet.
The adapter is still what proves the schema generalizes across harnesses — just one milestone later.

**Tech:** TypeScript on Node, `npx`-first. **`node:sqlite`** — no flag needed since Node 22.13.0, so
`engines: { node: ">=22.13" }`; it is Release Candidate (stability 1.2) rather than fully stable, which
is an accepted risk in exchange for zero native dependencies. `better-sqlite3` is the fallback if the
RC API bites. Vitest. Pinned versions, no telemetry.

## Revised milestone map

**M2 is too big for one milestone and splits into M2a / M2b.** It was carrying 13 detectors, outcome
classification with four states and its test matrix, `PROMPT` generation, the `claude-md` audit, the
Parquet adapter, `MEMORY` diffs, the running-score rate engine with four honesty guards, and
incremental persistence. The seam is natural:

- **M2a — a shippable tool.** The detectors needing no outcome, incremental persistence, and the
  running score. At the end of M2a `npx agentsensei` produces the Quickstart's first-run output for
  real. **This is the first point the product exists.** (Originally scoped at 8 detectors; after the
  2026-10-19 reset it is 4, chosen by measurement rather than by catalogue order.)
- **M2b — outcomes and artifacts.** Outcome classification with its tri-state test matrix,
  `convergent_iteration` then `rework_loop` + `fail_fix_fail`, `PROMPT`/`MEMORY` generation, the
  `claude-md` audit, and the SWE-chat adapter.

M2a first means the score and persistence are exercised by real use before the riskiest detectors
land on top of them.

> **M2a was restarted on 2026-10-19.** The order below was "cheapest and most certain first", which
> put the three *rarest* dimensions at the front — and all three read text to decide. Across 1,139
> real sessions they produced **5 true positives against ~25 false positives**, and all three are now
> deleted. See `GRAVEYARD.md` for each one with its evidence, and
> [docs/findings-frequency.md](docs/findings-frequency.md) for the measurement.
>
> The replacement rule is enforced by the compiler: `DetectorContext.events` is `StructuralEvent`, so
> reading `command`, `pattern` or `textSummary` in a detector is a build failure. A harness string may
> *name* a finding via `src/detect/labels.ts`, applied by the runner after the finding already exists.
>
> **The verification family went with it** — `no_verification`, `tdd_fail_then_pass`,
> `premature_external_write`, `fail_fix_fail` — because identifying a test command is irreducibly
> framework-specific. `no_verification` was the most actionable sentence this tool could produce, and
> that cost was accepted knowingly.

### M2a, restarted — build order by anchorability, not frequency

A finding needs a turn to point at. That, not how often something occurs, sets the order.

| # | dimension | status | measured |
|---|---|---|---|
| 1 | **`edit_retry`** | **done** | 380/1,139 sessions (33.4%), 927 instances, 0 false positives in 28 hand-read findings |
| 2 | `file_churn` | next | 11% of sessions, 401 instances |
| 3 | `context_reingest` | next | p50 17.9, p90 159.5 — session **metadata**, not a finding |
| 4 | **`redundant_call`** | **done** | 54/1,139 sessions (4.7%), 66 instances, every one a distinct turn |

Then: incremental persistence and the running-score rate engine with its four honesty guards.

**Known gap, not a decision:** `Config` has no `preset` and no per-dimension `mute`, so a dimension
someone does not care about cannot be silenced. That has to land before more dimensions ship.

Deliberately unbuilt, each with its reason in [docs/dimensions.md](docs/dimensions.md):
`reading_spiral` (51% but sidechain-confounded, widest set A/B gap in the table),
`permission_denied` (18.1% and structural, but declining is the person exercising control),
`user_correction` (needs the 200-char prompt cap raised first — 45% of prompts hit it,
measured in docs/data-sources.md; the judge now bypasses the cap via `withFullText`),
`user_interrupt` (the published 64% was counting turn-boundary enqueues and `<task-notification>`).

**M2a status: foundation + 1 of 4 detectors.** Done: window→events plumbing, finding identity and
merge, the detector contract with failure isolation and a text-free event view, the denominator pass
including the harness-billed token totals, the label tier, and `edit_retry`. Remaining: 3 detectors,
the config/mute surface, SQLite persistence, the score engine.

**Every one of the framework's first three real-data findings was a false positive**, and each bought
a rule. Kept because the rules outlived the detectors that earned them:

| Finding | Why it was wrong | Rule added |
|---|---|---|
| `tool_loop` ×16 | `command`/`filePath`/`pattern` cover Bash, Read, Edit and Grep only, so six separate `TaskCreate` calls looked like one call repeated | `Event.argHash` — a digest of the call's **full** arguments |
| `inaccurate_self_report` "done" | The "failure" was a **user denying a tool permission** | a failure must come from a recognised verification command |
| `inaccurate_self_report` "fixed" | *"fixed all the sidechain tests. Only one test is still failing"* — an honest, self-qualifying report | an acknowledged remainder disqualifies the claim |
| `revert_churn` | matched `git reset --hard` **inside a heredoc body** — this project's own docs | heredoc bodies stripped before any command match |

**After the fixes: 0 findings across 227 sessions.** Precision is therefore unfalsified rather than
demonstrated, and **recall is entirely unvalidated on real data** — positives exist only in synthetic
fixtures. Two things follow. The published 22.6% for `inaccurate_self_report` is not a comparable
baseline (it comes from human-labelled misalignment episodes, not arbitrary sessions), and only 37 of
the 227 sessions exceed 20 events, so the corpus is mostly short fixtures. This is exactly the gap the
**M4 gold set** closes, and it is the strongest argument for not deferring it.

**M2b**, once M2a is in real use:

6. **Outcome classification** with its four states, `unknown` included — the gate for what follows
7. `convergent_iteration` **before** `rework_loop`, deliberately: the discriminator must work before
   the thing it discriminates ships
8. `rework_loop` + `fail_fix_fail` — gated out of `core` and `ambient` until `eval` measures them
9. `PROMPT` + `MEMORY` generation, `agentsensei claude-md`, and the SWE-chat adapter

**Not** in M2 at all: `history.jsonl` prompt-level analysis, since the `prompt_*` dimensions need a
classifier — so the 10-month retrospective slips to M5 with the semantic tier.

M3 SQLite + dashboard + the findings queue. **M4 moves up** — the gold set no longer waits on local
data, and `rework_loop`'s gate opens here or not at all. M5 models, which is also when
`history.jsonl` analysis arrives.

**M6 is now the plugin milestone, and it is bigger than "install hooks":** the `.claude-plugin`
manifest, `hooks.json`, the `scripts/` entrypoints, the `/sensei:*` commands, the producer/consumer queue
with its three anti-nag rules, `init` with per-harness consent and `--print-only`, `uninstall`, and
the weekly digest. The `Stop`-stdout display question gets verified at the start of M6, before the
ambient design is built on it.

Two items move **earlier** because M6 depends on them being right:
- The **queue** (append-only findings file + dedup by finding identity + surfaced-flag) is designed in
  **M3** alongside SQLite, not bolted on at M6.
- `scripts/` path-and-session-id-from-arguments discipline lands in **M1**, since retrofitting
  harness-agnostic entrypoints after the CLI assumes `~/.claude` is the expensive order.

---

## Verification

- `npx vitest` — parser tree reconstruction, redactor planted secrets, skeleton compression ratio,
  each detector against its synthetic fixture. The rewind-branch fixture is **hand-built from
  inference**, so it is marked as such in the test file and re-derived from a real captured branch as
  soon as a real one appears in a session.
- `ls -ld ~/.local/share/agentsensei` — asserts `0700`, and that the path is outside any sync root
- **Running-score honesty tests** — assert no percentage is shown below the minimum denominator (raw
  `2 → 1` instead); assert deltas compute on rates not counts, by feeding two windows with equal
  counts but different session lengths and requiring a non-zero delta; assert a guarded dimension
  renders "suppressed, not improved"; assert `neutral` polarity dimensions carry no value judgment
- **Incremental persistence test** — kill a `report` mid-run and assert every completed window is
  already stored and the next run resumes rather than restarting
- **Concurrent-download test** — two processes invoking `models install` simultaneously: assert one
  downloads, the other waits and reports, exactly one copy on disk, and no corrupt partial file
  passes the stamp check
- **Session-start report** — renders the pre-computed aggregate with no computation in the hook, and
  contains **statistics only**; assert no behavioural instruction appears unless a brief is explicitly
  opted into, and that an active brief marks its dimension *suppressed* in trends
- **Chunk-boundary detection** — fixtures for a commit landing, verification flipping to passing, a
  completed todo list, and a compaction; assert a nudge lands at those and not at arbitrary turns
- **Never-interrupt tests** (M6): assert the `Stop` hook writes **nothing** to stdout, stderr, or
  `/dev/tty`; assert no statusline change while a response is streaming; assert nothing surfaces on
  a session's first boundary; assert `init` wraps rather than replaces an existing `statusLine`;
  assert `dimensions.ambient: []` produces zero live output. A regression here is worse than a wrong
  finding, so these are assertions, not manual checks.
- `agentsensei scan && agentsensei scan` — second run reads zero bytes (incremental proof)
- `ls <store>` — `index.json` and nothing else; no transcript copy exists anywhere
- `agentsensei scan --source test/fixtures/projects --archive /tmp/h1` — the whole pipeline runs
  against fixture directories, touching no real home-directory path. This is the test-suite path and
  the proof that nothing is hardcoded.
- `agentsensei config` — prints resolved paths and which layer (flag / env / file / default) set each
- `git diff` on `~/.claude/settings.json` after a full run — must be empty; the product never writes it
- `agentsensei skeleton <local-session>` — prints a readable skeleton of a real catalogued session
- `agentsensei session` run from inside a live Claude Code session — reads the in-flight transcript and
  reports on turns past the last catalogued offset
- `agentsensei report --since 2026-01-01` — returns prompt-level depth for the pre-catalog period and
  labels it as such, rather than silently returning nothing
- `agentsensei eval` (M4) — three labeled blocks; the gold block is the only one quoted as precision
- **Outcome tri-state tests** — the MVP's critical safety path. Fixtures for: a repo with no test
  suite, work left uncommitted on a branch, a non-git directory, and verification run outside the
  session. Pass condition in every case is `outcome: unknown` and **`rework_loop` silent** — never
  `abandoned`, which would be the false flag that destroys trust.
- `agentsensei claude-md` on a real `CLAUDE.md` — classifies rules as ceremonial / ineffective /
  working, and runs on the first invocation with no accumulated history
- `agentsensei doctor` — catalog size, harness TTL, and the network claim stated precisely as
  **"no network calls during analysis"** rather than "no network capability." Re-checked against the
  final design and it holds: the only network access anywhere is the user-initiated model download,
  which is setup, not analysis — and hooks can never trigger it. `doctor` additionally reports both
  storage paths separately (store and models) since they now differ. The weaker claim is needed
  because "no network capability" becomes false
  at M5, when the bundled embedding model downloads lazily on first use. Scoping the claim now avoids
  having to walk back a user-facing honesty guarantee three milestones in.
- Per-milestone: wall-clock scan time, peak RSS, CPU on real sessions, reported in the summary

## Open items

- **License discrepancy** — the HF card says ODC-BY, the paper says CC BY 4.0. Both are attribution
  licenses permitting redistribution of derivatives, so the conclusion holds either way: attribute and
  ship. Still worth resolving at download and recording in `docs/data-sources.md`, because ODC-BY
  governs the *database* while contents can carry separate rights.

  **Why it matters at all — only one of the three uses involves redistribution:**

  | Use | Redistributes? | License bearing |
  |---|---|---|
  | Dev/testing — running our parser over real sessions to validate the adapter and detectors | no, just use | minimal |
  | Training the SetFit heads offline on their LLM-judge labels; we ship the weights | derived artifact | attribute to be safe |
  | **The gold/silver fixtures committed into our repo** | **yes** | **this is the binding case** |

  The fixtures are committed so **`eval` works on a fresh clone.** `eval` is a shipped command, and if
  its fixtures are not in the repo then verifying our precision claim requires an HF account and a
  47 GB download — which defeats the purpose of publishing a precision number.

  **Mitigation already built in: the fixtures are skeletons, not transcripts.** Redaction strips file
  contents, absolute paths and identifiers by construction, so what we commit carries far less of the
  original than a raw transcript would. The skeleton format was designed for token budget, privacy,
  and future team sync — it also turns out to be what makes redistribution safe.
- **Provisional findings in live mode** — showing a rework loop as "in progress, outcome unknown" is
  honest, but it may still read as a nag at turn 14. Worth testing on real sessions in M2 and
  suppressing entirely if it proves annoying; the live surface can be constraint-decay-only and still
  be valuable.
- **HF account needed at M2** — downloading SWE-chat requires a Hugging Face login and sharing
  contact info with the dataset host. One-time and development-only; it does not affect the shipped
  tool. Not blocking for M0/M1 now that the adapter moved to M2, and it needs a deliberate decision
  before anyone downloads 47 GB of gated data.
- **Differentiation needs empirical confirmation** — the four surviving claims are argued from
  documentation. M0 runs vibe-log-cli and agentsview on real data to confirm the gap. If vibe-log
  turns out to already link findings to evidence, the positioning narrows to quota + measured
  precision, and that is worth knowing in week one rather than month three.
- **Registry and repo names** — tracked outside this document. A public planning
  file is the wrong place to record which names are available, for reasons that
  become obvious the moment the repository is public.

- **Statusline refresh timing** — the ambient channel is the statusline (hook stdout is model-facing,
  verified). Still unconfirmed: how promptly the statusline re-renders after a `Stop` boundary.
  Tested with a stub statusline script in M3, before M6 depends on it.
- **Copilot CLI plugin/hook support** — unverified. Claude Code, Codex and Cursor are confirmed from a
  real installed plugin; Copilot is researched when it comes up, not assumed.

---

*Extracted from the planning document (2026-10-12/15). Reasoning is kept with each
conclusion deliberately — see [DECISIONS.md](DECISIONS.md) for the index.*
