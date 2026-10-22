# Graveyard

Things this project built, measured, and removed — with the evidence that killed them.

Kept because the reasoning is the expensive part. A verdict without its evidence guarantees the
decision gets re-litigated, and every entry here cost real measurement to reach.

**Removed 2026-10-19**, in the reset that followed measuring the first three detectors against 1,139
real Claude Code sessions from SWE-chat.

---

## The one cause behind all of it

Across 1,139 sessions the three shipped detectors produced **5 true positives and ~25 false
positives**. Every failure had the same shape: **the detector read text to decide something.**

Text is an open space. There are thousands of frameworks and infinite phrasings, so a rule over text
is a guess with good manners. The replacement rule — structure decides, a harness string may only
*label* — is now enforced by the `StructuralEvent` type rather than by discipline.

---

## `src/verify.ts` — verification discovery (445 lines)

**What it did.** Learned which commands verify code, without a framework list: result vocabulary
(`N passed`, `ok`, `FAIL`, `AssertionError`) *nominated* a command, and running after an edit at least
twice *confirmed* it. Genuinely clever, and the right instinct — discover from behaviour, never
configure.

**Why it died.**

- The nomination step reads **result vocabulary, an open space**. Every tool phrases its verdict
  differently; the list could never be complete. This is the rule the reset exists to enforce.
- **It never produced a single finding** in the project's history.
- Structurally capped: only **226 of 1,139 sessions (20%) are warm**, so 80% of sessions were silent
  by construction.
- Verdict-variation — the strongest half of the idea, "a verification command is one whose verdict
  changes when the code changes" — confirmed **0 commands**, because **111 of 127 verdict-bearing
  results are pipelines** whose exit status belongs to `tail`, not the test runner.

**What dies with it:** `no_verification`, `tdd_fail_then_pass`, `premature_external_write`,
`fail_fix_fail`. All four need to know which command is a test, which is irreducibly
framework-specific. `no_verification` was called "the most directly actionable sentence the tool can
produce" — losing it is the real cost of the reset, and it was paid knowingly.

**Worth keeping if this is ever revisited:** the confirm-by-behaviour half is sound. The nominate-by-
vocabulary half is what has to be replaced, and pipes destroy the obvious structural alternative.

---

## `src/detect/inaccurate-self-report.ts` — claimed success while something failed (185 lines)

**Record: 0 true positives, 5 false positives.** Every one was an honest report.

```
"Worktrees are done — 8 removed."          ← true; the timeout was a different loop
"#1228 is done and #1215's verdict…"       ← true; a specific item completed
"All 118 unit tests pass. There's still
 one integration test failure on
 shelley.cddl at line 195."                ← honest and self-qualifying
```

**Single root cause:** the claim is scoped to a specific thing while an *unrelated* command failed.
The `ACKNOWLEDGES_REMAINDER` guard missed the third because it says "there's still one integration
test failure" rather than "still failing" — the regex can be widened forever and will keep leaking.

The spec predicted this exactly: *"the claim is scoped to a subset — this is the one real
false-positive path and it needs **scope matching** between the claim and the failure."* Scope
matching means knowing whether the failing thing is the claimed thing. That is semantics, not a rule.

**Verdict:** not shippable as `RULE`/`LEX`. Belongs behind a classifier or not at all.

---

## `src/detect/claims.ts` — `isSuccessClaim` (53 lines)

Lexical detection of a success claim in assistant prose. Its last consumer was the
`successClaimCount` denominator (6,836 claims over the corpus), which the new voice — *what the
session cost, with receipts* — does not use. No consumer, open space, gone.

---

## `src/detect/revert-churn.ts` — work discarded (122 lines)

**What it did.** Matched five destructive git verbs (`checkout --`, `restore`, `reset --hard`,
`stash drop`, `clean -f`) and reported the event as a fact, polarity `neutral`.

**Measured on the corpus: 198 executed destructive commands, ~30–40 false (15–20%).**

| false positive | count | why it is wrong |
|---|---|---|
| `git restore --staged <paths>` | 8 of 23 restores | unstages only; **never touches the working tree**. One is self-documenting: `# Unstage test files from staged set (they belong in commit 2)` — commit hygiene reported as churn |
| `git checkout --theirs X && git add X && git stash drop` | 2 | **conflict resolution**: the content was resolved and *kept*; the drop removes a now-redundant entry |
| `git branch <preserve> <sha>; git reset --hard` | several | the work was **explicitly preserved on a branch first** — the careful instinct the tool should reward, reported as loss |
| `git fetch && git reset --hard origin/main` | ~15 of 44 | syncing to canonical, not discarding |
| `git reset --hard` inside a heredoc body | 1 (earlier) | matched prose being *written to a file*, not a command |

**Also: the doc promised a guard the code never implemented.** The header said *"The command must
affect files **this session edited**"*; `detect()` computed `editedFiles()` and then only tested
`edited.length === 0`. Paths were never compared. Same shape as the NUL incident — doc and
implementation disagreeing while every test passed.

**Accidentally safe, worth knowing:** `--ours`/`--theirs` never matched, because the regex required
`-- ` with a trailing space. Correct behaviour reached by luck, not design.

---

## `src/detect/command.ts` — heredoc stripping (59 lines)

Born from the heredoc false positive above: `cat > f <<'EOF' … EOF` had its *body* matched as a
command. The fix was correct and well-tested. It existed solely to make command-text matching safe,
and there is no command-text matching any more.

---

## `tool_loop` → rebuilt as `redundant_call`, not buried

The one detector whose signal survives the new rule intact: `toolName|argHash` identity plus
`outHash` identity, zero text. **5 of 5 findings survived hand-inspection** — the project's only true
positives. Knowledge that must not be re-learned:

- **Key on `argHash`, never on `command`/`filePath`/`pattern`.** Those three fields cover Bash, Read,
  Edit and Grep and nothing else; comparing them produced 19 runs of which **16 were different calls
  that merely looked identical** — six separate tasks and seven separate subagents, at `certain`.
- **The output must be identical too**, via `outHash` and not `textSummary`: the summary caps at 200
  characters and **59.9% of real results hit that cap**, so comparing summaries compared *prefixes*.
- **The normaliser must preserve counts.** Blanket digit-stripping collapsed `3 failed → 2 → 1` into
  one string, reporting steady progress as a loop. It survived an earlier test only by accident, via
  `tests`/`test` pluralisation.
- **Polling tools are not loops** (`BashOutput`, `TaskOutput`, `Monitor`, `ListAgents`). A poll
  returning `running` three times is identical output and legitimate use.
- **An argument-less call cannot be compared** — treat as a break, never as a match.
- **Residual hole, unfixed:** a self-truncating command (`tsc --noEmit 2>&1 | head -30`) throws its
  own output away upstream of us, so `outHash` digests a prefix. Downgrades to `high`, never suppressed.

---

## The statusline and its queue (358 lines)

**Removed 2026-10-19, and not because it was broken.** It worked: rate-limited,
decaying, session-scoped, hand-verified live on a real machine, rendering
`⌁ 3 edits refused then retried in 4 past sessions`.

It was removed because of what it cost and what replaced it:

- **A permanent row of screen** for one line that rarely changes. The user's
  words: *"it's taking up good real estate"*.
- **Zero of ~40 official Claude Code plugins ship a `statusLine`.** It is not how
  this ecosystem surfaces anything.
- **`systemMessage` turned out to be a user-visible channel**, which removed the
  reason the statusline was chosen in the first place. The original analysis
  picked it because hook *stdout* reaches the model, making every other channel
  an observer effect. That is true of stdout and false of the hook's JSON
  `systemMessage` field — see `docs/surfaces.md`.

**Three guards died with it, and a future statusline must re-derive them:**

| guard | why it existed |
|---|---|
| rate limiting | one change per 3 boundaries, so the line does not flicker |
| decay | an unacted entry dropped after 12 boundaries, so it stops accusing |
| session scoping | two windows share one archive, and an unscoped pick showed one session a finding about another's turns |

Also lost: the producer/consumer split that kept analysis out of the hook. The
standing pass keeps that shape, so the lesson survives even though the queue does
not.

**One bug it taught, worth keeping:** `enqueue` dropped `shownAt` while the
detached analyser re-enqueued every boundary, so the rate limit never engaged and
the decay never fired. Both guarantees were silently inert and nothing threw. A
guarantee that lives only in data needs a test that reads the data back.

## `reading_spiral` — 51% of sessions, and 99% of it was working

**Never built, and that is the point.** It was the largest unbuilt dimension in
the catalogue and would have been the obvious next detector. Three measurements
killed it, in order:

| check | result |
|---|---|
| the *published* confound — sidechain fan-out | **4 of 2,182 — 0%.** Documented, never measured, and wrong |
| overlap with `redundant_call` | **1 of 2,182** — a genuinely distinct signal |
| **were the 3+ reads the same call?** | **15 same, 2,167 different — 99% not the same call** |

The probe asked "was this path read 3+ times with no edit between". The answer
it got was yes, constantly — because **the same path is not the same question**:

```
turn    4  Read                                  ← read the file
turn    8  Grep  pattern="RunnerEvent"           ← then ask one thing
turn   10  Grep  pattern="tool_calls.is_empty()" ← then another
```

That is an agent studying a file before changing it. `Read` at different offsets
is a large file read in pages; `Grep` with different patterns is exploration.

**The genuine remainder does not rescue it.** All 15 same-argument repeats are
non-consecutive, so `redundant_call` sees none — and they split in two:

```
turns 39,41,43        tight   — genuinely redundant
turns 1419,1421,1423  tight   — genuinely redundant
turns 35,138,151      spread  — re-reading a PLAN.md across a long session
turns 11,57,100       spread  — re-checking lib.rs hours apart
```

The wide ones are legitimate; that is what a plan file is for. The actionable
subset is **3–5 instances across 1,139 sessions — 0.3%**.

`redundant_call`'s consecutiveness guard was deliberately **not** relaxed to
chase them. That guard is much of why it has never been wrong, and trading it
for three findings is the bargain this project keeps refusing.

**The transferable lesson:** a probe keyed on a path will over-count any tool
that takes other arguments. Key on what identifies the *call* — which is what
`argHash` exists for.

## Five probes that counted a harness mechanism and called it behaviour

The procedural lesson, now a rule in `CLAUDE.md` and in `scripts/measure-dimensions.ts`:
**a probe over a harness mechanism must first establish that the mechanism means what its name
suggests.**

| probe | claimed | what it actually counted |
|---|---|---|
| `prompt_withdrawn` | 37% of sessions | `remove`/`popAll` carry **empty content** and sit between a `tool_use` and its `tool_result` — queue bookkeeping. `enqueue 3,606 ≈ dequeue 2,138 + remove 1,315`: nothing is withdrawn |
| `user_interrupt` | 64% of sessions | **3,504 of 3,606 enqueues occur at a turn boundary**; only 102 land mid-flight. Of those carrying content, **1,858 are `<task-notification>`** — the harness queueing its own messages |
| `error_ignored` | 62% of sessions | of 234 matches, **≥68 were the agent fixing** and 55 more investigating. A non-zero exit is not an ignored error |
| `premature_external_write` | 38% of sessions | counted **every** push. Pushing to a personal branch where CI is the gate is normal and indistinguishable |
| `cache hit rate` | 97.7%, "an outlier is real" | `cache_read` re-counts the **entire prefix on every API call** — quadratic in turn count, so the ratio is pinned near 1 by construction. Measured spread `read/(read+create)`: **p10 0.901 → p90 0.985**. An "outlier" is just a short session |

The fifth was caught in review before it shipped, which is the only reason it is a footnote rather
than a sixth deleted detector. The adjacent metric survived it: `cache_creation / output_tokens`
spreads **7.5× p90/p50** and is behavioural.

---

## `docs/dimensions.md` — the 40-dimension catalogue

Not deleted; **reclassified**. It was derived from five published taxonomies of *agent reasoning
failures* (MAST, Developer-Agent Misalignment, Model-or-Harness, OpenClawBench,
Prompt-Quality→PR). Those papers study whether agents reason correctly, and the catalogue inherits
their quality on that question.

What they do not study is **the harness being awkward to work in** — which is what real friction
actually is. Of **381 real friction statements** in the corpus, **3** map to a process failure that
catalogue detects. The dominant themes are stale diagnostics, tabs-versus-spaces edit failures,
local-passes-CI-fails, and the problem simply being hard.

It lives on in `docs/prior-art.md` as what it is: a literature survey, not a backlog.

## Ten detector candidates measured and rejected, 2026-10-20

Measured against the 1,139-session SWE-chat corpus after `edit_retry` and
`redundant_call` were working. Recorded because the negatives cost real time to
establish and would otherwise be re-proposed.

First, a population check, because the project had been assuming otherwise: the
corpus is **not** mostly autonomous one-shot runs. Median 6 user prompts, 54
minutes, and only 13% are single-prompt. It is a valid population for "what
happens out there", and a single developer's own sessions are not.

### `stale_read` — 27.7% of sessions, and every one of them explained

The shape: read a file, the harness's file-history records it changing, edit it
without re-reading. 2,078 instances, 1,965 of which the edit *succeeded* — so
`edit_retry` was not already catching them.

**100% follow one of the agent's own prior edits to that file.** Not 90%: all
2,078. The file-history snapshot lags the edit call by a variable number of
turns — 28% within 10, 78% within 50 — which is why a 3-turn window showed only
0.1% and made the signal look clean. Widen the window and the whole thing
dissolves. It was detecting "agent edited, harness snapshotted, agent edited
again", which is sequential editing.

### `permission_denied` — 18.1%, and it is the person working normally

The harness marks these `failureKind: 'denied'`. On real interactive data the
denials are `ExitPlanMode` and `AskUserQuestion` — a person rejecting a plan or
answering a question, which is plan mode functioning. Reporting it as waste
would be telling someone their own decisions cost them tokens.

### `interrupted` and `userModified` — present 1,314 and 186 times, never true

`toolUseResult` carries both fields, and they looked like exactly the harness
ground truth that made `edit_retry` work: the harness saying a call was killed,
or that the *human* edited the file. Across 1,127 corpus sessions neither is
ever `true`. The sixth instance of *signal availability is not frequency*.

### `self_truncated` — 82%, and truncating is usually correct

`cmd | head -30` clips its own output. Clipping once and moving on is the right
thing to do; only re-running it wider is waste, and telling those apart needs to
read and compare command text. See the note on truncation in
`src/detect/redundant-call.ts` for where this stops.

### The rest

- **`exitCode != 0`** — 55.6%, but failing commands are the point of running
  them. Already buried above as `error_ignored`, where 234 matches were ≥68 the
  agent fixing and 55 investigating.
- **`file_churn`** — 48% of sessions edit some file 5+ times, 23% do 10+. That
  churn is waste is not established, and `MOST REWRITTEN` already reports the
  same fact without claiming it.
- **`cascade_failure`** — 3.3%, exact, and genuinely wasteful, but 113 incidents
  across 1,139 sessions and **one** killed call each. Buildable; not worth a
  dimension yet.
- **Bash, Grep and Read refusals** — Bash has 147 but only 3 carry a harness
  reason and **none** are retried. Grep has 4 retried, Read 27.

### What this says about the structural tier

The harness's labelled-failure well is **exhausted by `edit_retry`**: Edit and
Write are 998 of roughly 1,400 tool refusals and both are covered. There is no
second `edit_retry` waiting in the failure data. Further structural detectors
will be small; the next real gain is the semantic tier.

---

## The judge campaign, 2026-10-21/22 — what died, what was wrongly buried

Four days of measurement, ~$14, and the two entries that were written during it
were **both wrong**. They are corrected here rather than quietly dropped,
because the way they went wrong is the most useful thing the campaign produced.

### Correction 1: the rubric change did not fail. It is worth +11 points.

An earlier entry recorded "the rubric widening" as buried — recall down, false
positives up 13 → 19. That was measured on 60 of 246 available sessions, against
a baseline that had been edited mid-experiment. On the **full** labelled set:

```
                   session        episode        claim     false-pos
  old rubric       104/232  45%   151/437  35%   96/557 17%     -
  new rubric       129/232  56%   196/437  45%  119/557 21%   123
  + two-stage      165/232  71%   290/437  66%  175/557 31%   149
```

**+11 session recall for the rubric, +15 more for two-stage, +26 together.**
Precision barely moved: true catches per false alarm went 1.05 → 1.11, so the
wider net cost nothing it was feared to cost.

The retraction is **scoped**, because the code had already settled this in a way
the entry did not notice. `83b7cda` re-adopted two of the three widened tests:

```
  constraint_violation   WIDE, live    source restriction dropped
  misread_intent         WIDE, live    correction requirement dropped
  overreach              NARROW        push-back requirement KEPT
```

So the gain came from **dropping the source restriction** — a constraint stated
in a skill file, a slash command or a project instruction file now counts, where
before only a developer prompt did. The push-back clause the original entry
defended is still in force for `overreach`, and nothing here contradicts it.

### Correction 2: there is no 16-point variance band. That was my own edit.

An entry reported three runs of "identical code" at 52%, 66% and 67% and
concluded that judge recall swings 16 points on sampling alone. A later
"correction" blamed the sample size.

Both are wrong. **`src/judge.ts` was rewritten at 19:49:16, during the
experiment.** Each scoring run is a fresh node process that imports the file at
startup, so run 1 read the old rubric and runs 2–3 read the new one. Three
independent signals agree: `other` findings appear only in runs 2–3, finding
volume jumps 77 → 108/104, and `overreach` quadruples exactly as its rubric
gains a disambiguator.

**True same-code variance is run 2 against run 3: 66% vs 67%. About one point.**
The judge is far more stable than that entry claimed, and single-run comparisons
are correspondingly more trustworthy — provided the code holds still.

### What this leaves behind, and it is mechanical rather than a resolution

Three methodological failures in one campaign, all the same shape — *the thing
being measured did not hold still*:

```
  1. shipped the response contract and the rubric together, so one masked
     the other and two mistakes cancelling read as a neutral result
  2. edited src/judge.ts during a variance experiment
  3. sampled 60 of 246 sessions across a dozen runs, because an early cost
     decision picked 60 and nobody revisited it
```

Two of the three were caught by the user asking a question, not by the care of
whoever was running them. So:

- **`noUnusedLocals` and `noUnusedParameters` are on.** Their absence is why two
  dead functions sat in `src/judge.ts` with 60 lines of docstring through the
  whole campaign.
- **Scoring reads the whole labelled set.** Sampling it was never a decision.
- **A deterministic re-score from a cached run has zero variance**, and is how
  any change to scoring or derivation should be measured. It is why the
  quote-anchor fix (16% → 20% claim-level) is the one result from that week that
  needs no error bar.

Still open and recorded so it is not re-discovered: **`overreach` scores 1/38,
1/38 and 2/38** across three arms and two models. Established as broken rather
than untuned. Retiring a dimension is a product decision, so it stays for now.
