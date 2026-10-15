# Dimensions

## The dimensions we analyse — full catalogue

40 dimensions across 10 groups. Every entry carries the same fields, and the two that matter most are
**how it is measured** and **how much to trust it.**

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

Some dimensions simply cannot run without specific inputs. This matters for your machine today: with
zero surviving transcripts, only the `H` dimensions work on historical data.

`T` transcript · `H` history.jsonl (prompts only) · `G` git / worktree state · `PC` PreCompact capture · `MS` multiple sessions · `TOK` token usage

### Master index

| Dimension | Group | Method | Conf | Live | Data | Preset | `P` |
|---|---|---|---|---|---|---|---|
| `user_correction` | E friction | `LEX`+`CLS` | high | yes | T | **core** | 45.7% of turns |
| `inaccurate_self_report` | D honesty | `RULE` | **certain** | yes | T | **core** | 22.6% |
| `no_verification` | G verification | `RULE` | **certain** | yes | T | **core** | 21.3% |
| `constraint_decay` | B decay | `LEX`+`EMB` | high | yes | T | **core** | 38.3% |
| `repeated_instruction` | B decay | `EMB` | high | yes | T,MS | **core** | — |
| `tool_loop` | A looping | `RULE+T` | **certain** | yes | T | **core** | 2.9% / 15.7%² |
| `scope_overreach` | D overreach | `RULE+T` | high | yes | T | **core** | 10.2% |
| `prompt_specificity` | I user | `CLS` | medium | yes | H | **core** | OR≈66 |
| `revert_churn` | A looping | `RULE` | **certain** | yes | T,G | **core** | — |
| `error_ignored` | G verification | `RULE` | **certain** | yes | T | standard | top-mass³ |
| `premature_action` | C intent | `RULE` | **certain** | yes | T | standard | 11.1% |
| `premature_external_write` | G verification | `RULE` | **certain** | yes | T,G | standard | — |
| `unverified_acceptance` | I user | `RULE+T` | high | yes | T | standard | — |
| `vague_correction` | I user | `LEX` | medium | yes | T | standard | — |
| `effective_correction` | F healthy | `LEX` | medium | yes | T | standard | — |
| `prompt_verification` | I user | `CLS` | medium | yes | H | standard | OR≈7.8–8.5 |
| `prompt_context` | I user | `RULE`+`CLS` | high/medium¹ | yes | H | standard | OR≈2.1 |
| `user_interrupt` | E friction | `RULE` | **certain** | yes | T | standard | 4.5% of turns |
| `clarification_churn` | C intent | `RULE+T` | high | yes | T | standard | — |
| `fail_to_ask_clarification` | G verification | `CLS`+`OUT` | medium | no | T | standard | 6.8% |
| `unaware_of_termination` | G verification | `RULE+T` | medium | yes | T | standard | 12.4% |
| `reading_spiral` | A looping | `RULE+T` | medium | no | T | standard | — |
| `goal_drift` | H context | `EMB` | medium | yes | T | standard | — |
| `context_rationale_erosion` | H context | `RULE`+`EMB` | high | yes | T,PC | standard | — |
| `underspecified_prompt` | C intent | `CLS`+`OUT` | medium | yes | H,T | standard | 15.4% |
| `rework_loop` | A looping | `RULE+T`+`OUT` | medium | **no** | T,G | standard | 17.8% |
| `fail_fix_fail` | A looping | `RULE`+`OUT` | high | **no** | T | standard | 17.8% |
| `convergent_iteration` | F healthy | `RULE`+`OUT` | high | no | T,G | standard | — |
| `tdd_fail_then_pass` | F healthy | `RULE` | **certain** | no | T | standard | — |
| `legitimate_debug_reread` | F healthy | `RULE+T` | medium | no | T | standard | — |
| `exploratory_prompting` | F healthy | `RULE`+`OUT` | medium | no | T | standard | — |
| `weak_evidence_commitment` | G verification | `JUDGE` | low | yes | T | all | — |
| `capability_overcommitment` | G verification | `JUDGE`+`OUT` | low | no | T | all | — |
| `abandonment` | E friction | `EMB`+`OUT` | medium | no | T,MS | all | — |
| `context_saturation` | H context | `STAT` | low | no | T,MS | all | — |
| `context_hygiene` | I user | `STAT` | medium | no | T,MS | all | — |
| `permission_rubber_stamping` | I user | `RULE+T` | medium | yes | T | all | — |
| `irreversible_action` | J risk | `RULE` | **certain** | yes | T | **off** | — |
| `secret_exposure` | J risk | `RULE` | high | yes | T | **off** | — |
| `spend_without_progress` | deferred | `RULE+T` | — | — | TOK | **off** | — |

¹ `prompt_context` splits: the structural half is `high`, the sufficiency half `medium`. Reported separately — see group I.
² 2.9% as Operational Execution Error (misalignment study); 15.7% as Step Repetition (MAST).
³ Highest anomaly mass of OpenClawBench's five classes.

**A standing caveat on the `P` column.** These are **published real-world prevalences and effect
sizes — they are not our accuracy.** They answer "does this pattern matter?", never "how well will we
detect it?" Two specific hedges:

- `OR ≈ 66` for `prompt_specificity` is an observational odds ratio, and one that large usually
  reflects a near-deterministic relationship or a thin cell count. It justifies putting the dimension
  in `core`; it says nothing about how well our classifier will score it.
- Prevalences come from corpora of 20k+ sessions across many users. **Your** distribution will differ,
  and the per-user deviation from these baselines is often the more interesting finding.

---

### A. Rework and looping — wasted motion

**`rework_loop`** — the same file or region edited repeatedly without converging.
`RULE+T`+`OUT` · conf `medium` · live **no** · agent-side · data `T,G` · standard
```
U: "fix the login bug"
Read auth.ts → Edit auth.ts (60 lines) → Test: FAIL (3) "token undefined"
Edit auth.ts (55 lines, 80% similar) → Test: FAIL (3) same error
U: "it's still broken"                              ← correction, no convergence
```
*Measure:* ≥N edits to the same file inside a window, diff similarity above threshold between
consecutive edits, **and** outcome ≠ converged. Similarity is a normalised diff ratio, not embeddings —
cheaper and more faithful for code.
*Wrong when:* **This is the highest false-flag risk in the catalogue.** It fires on healthy iteration
whenever outcome resolution is wrong or unavailable — no test command, no commit, work left on a
branch. It cannot distinguish "four edits converging" from "four edits flailing" without the outcome,
which is exactly why it is `OUT`-gated and excluded from `core`.
*Fix:* "Three attempts on the same file with the same failure — stop and re-read the error, or ask for
a different approach."

**`fail_fix_fail`** — the same test or build command fails repeatedly with edits in between.
`RULE`+`OUT` · conf `high` · live **no** · agent-side · data `T` · standard
*Measure:* identical normalised command + identical error signature ≥3×, with edits interleaved.
Error signature = normalised first error line + failure count, so flaky line numbers do not split it.
*Wrong when:* the test is genuinely flaky; or TDD, where the first failure is intentional (gated by
`tdd_fail_then_pass`). Misses cases where the error message changes slightly each run.
*Fix:* "Same failure three times — the hypothesis is wrong, not the implementation."

**`tool_loop`** — identical tool calls repeated with no new information.
`RULE+T` · conf **`certain`** · live **yes** · agent-side · data `T` · **core**
```
Bash: npm test → FAIL
Bash: npm test → FAIL      (identical command, nothing changed between)
Bash: npm test → FAIL
```
*Measure:* same tool + normalised arguments ≥N consecutive times with no intervening state change
(no edit, no new file read). Normalisation strips absolute paths and volatile flags.
*Wrong when:* legitimate polling — waiting on a build, a deploy, or a flaky network call. Mitigated by
requiring *no intervening state change*, but a genuine retry-with-backoff will still trip it. Keep N
configurable for this reason.
*Fix:* "Identical command repeated with nothing changed in between — the loop needs breaking, not
retrying."

**`reading_spiral`** — the same files read repeatedly without edits or narrowing.
`RULE+T` · conf `medium` · live no · agent-side · data `T` · standard
*Measure:* ≥N reads of the same file, no edits between, and the read-set **not narrowing** over the
window. Narrowing is the discriminator against legitimate debugging.
*Wrong when:* **sidechains.** A parallel fan-out reads the same files legitimately — which is why
`isSidechain` attribution is a correctness requirement, not a nicety. Also fires on large-file
re-reads that are genuinely necessary when context was compacted.
*Fix:* "Six reads of the same three files with no edits — the information needed isn't in those files."

**`revert_churn`** — work is discarded.
`RULE` · conf **`certain`** · live **yes** · either-side · data `T,G` · **core**
*Measure:* `file-history-snapshot.trackedFileBackups` restoration events, or destructive git commands
(`checkout --`, `restore`, `reset --hard`, `stash drop`) affecting files edited in this session.
*Wrong when:* intentional cleanup of a deliberate spike or experiment. The *event* is certain; the
*interpretation* ("this was waste") is not — so it is reported as "work discarded", a neutral fact,
rather than as a failure.
*Fix:* Pairs with `rework_loop` for the week's biggest time sink.

### B. Context and instruction decay — the largest category in the real world

**`constraint_decay`** — a constraint the user stated earlier is violated later.
`LEX`+`EMB` · conf `high` · live **yes** · agent-side · data `T` · **core** · `P 38.3%`
```
U (turn 3):  "use pnpm, never npm"
...
turn 31:     Bash: npm install lodash                ← violation
U (turn 31): "I said pnpm"                           ← user pays the correction cost
```
*Measure:* two stages. (1) **Extract** stated constraints from user turns — imperative or prohibitive
phrasing ("always", "never", "use X not Y", "don't"). (2) **Match** subsequent actions against them.
The second stage is cheap and exact for the common tool-level cases (a named command, package manager,
file path, or library), and `EMB` only for prose constraints. Highest-value shortcut: constraints that
name a *command* are checkable with a pure rule, and those are the majority.
*Wrong when:* the user *changed their mind* and the later instruction supersedes the earlier one —
SWE-chat's "mind changer" persona is a documented real pattern. Must check for an intervening
superseding instruction or it will falsely accuse on every legitimate pivot. Also misses constraints
stated in `CLAUDE.md` rather than in-session, unless that file is read too.
*Fix:* The strongest `agentsensei fix` output — "this constraint has been restated 3× across sessions;
here is the `CLAUDE.md` line that would make it stick."

*(The first draft had `post_compaction_drift` here. Superseded by the more precise, published
`context_rationale_erosion` in group H — same `PreCompact` mechanism, but it names **why** the decision
reversed. Merged, not dropped.)*

**`repeated_instruction`** — the user restates the same instruction, in-session or across sessions.
`EMB` · conf `high` · live **yes** · user-observable · data `T,MS` · **core**
*Measure:* pairwise embedding similarity between user turns above threshold, excluding adjacent turns.
Cross-session uses the same embedding over `history.jsonl`, which is why it works on all 10 months of
your data.
*Wrong when:* legitimately repeated context in a *new* situation ("use pnpm" in a different repo is not
decay). Needs project scoping. Paraphrase below threshold is missed, which is a recall problem rather
than a precision one — acceptable given the precision-over-recall principle.
*Fix:* Directly generates the `CLAUDE.md` addition. The clearest case of a finding becoming a durable
fix.

### C. Intent and specification

**`underspecified_prompt`** — a request vague enough that misinterpretation was predictable.
`CLS`+`OUT` · conf `medium` · live yes · user-side · data `H,T` · standard · `P 15.4%→27.0%`
```
U: "make it better"
Edit src/api.ts, src/db.ts, src/ui.tsx               ← agent guesses broadly
U: "no, I meant just the error messages"             ← misread intent, cost paid
```
*Measure:* prompt features (length, presence of file/path/symbol references, acceptance criterion,
scope markers) scored by a small classifier, **confirmed** by a correction within N turns. The
confirmation is what lifts it above guesswork — a vague prompt that worked fine is not a defect.
*Wrong when:* short prompts in a well-established context are perfectly clear ("yes", "continue", "now
the tests"). Prompt length alone is a bad feature; the classifier must use the correction signal.
*Fix:* Shows the before/after — the vague prompt and the clarification the user eventually had to give,
with the suggestion to lead with the second one.

**`clarification_churn`** — the agent repeatedly asks before acting.
`RULE+T` · conf `high` · live **yes** · agent-side · data `T` · standard
*Measure:* ≥2 consecutive assistant turns that end in a question and contain **no tool calls**.
*Wrong when:* **one clarifying question on a genuinely ambiguous task is good behaviour** and must not
be flagged. The defect is the pattern, not the instance — hence the ≥2-consecutive requirement.
*Fix:* Paired with `fail_to_ask_clarification` so the user learns which direction they err in.

**`premature_action`** — the agent edited before reading what it was editing.
`RULE` · conf **`certain`** · live **yes** · agent-side · data `T` · standard · `P 11.1%`
*Measure:* an `Edit` to a path with no prior `Read` of that path in the active session path.
*Wrong when:* the file was created in this session (nothing to read); or its content arrived via
another route — a grep result, a diff, a compaction summary, or a sub-agent's report. All of these are
checkable, and all must be checked or precision drops hard.
*Fix:* "Four of this week's edits went into files that were never read first — three needed rework."

### D. Agent overreach and honesty

**`inaccurate_self_report`** — the agent claims success the evidence contradicts.
`RULE` · conf **`certain`** · live **yes** · agent-side · data `T` · **core** · `P 22.6%`
```
Bash: npm test → FAIL (2 failing)
A: "Fixed — all tests pass now."                     ← contradicted by the line directly above
```
*Measure:* assertion language ("fixed", "all tests pass", "working now", "done") in an assistant turn
where the most recent verification result in the transcript is a failure, or where no verification ran
at all. **The contradiction is structural, which is why this is `certain`** — we are not judging
whether the claim is true, we are observing that the transcript disagrees with itself.
*Wrong when:* the claim is scoped to a *subset* ("fixed the import error" — true — while other tests
still fail for unrelated reasons). This is the one real false-positive path and it needs scope matching
between the claim and the failure. Also missed entirely when success is implied rather than stated.
*Fix:* The highest-trust finding the tool produces. "Three times this week the agent reported success
while tests were failing — the pattern is after a long debugging stretch."

**`scope_overreach`** — the agent did more than it was asked.
`RULE+T` · conf `high` · live **yes** · agent-side · data `T` · **core** · `P 10.2%`
```
U: "fix the typo in the README"
Edit README.md  ✓
Edit package.json, tsconfig.json, 4 source files     ← nobody asked for this
```
*Measure:* files edited that are not named in, or reachable from, the request's stated scope; plus
unrequested dependency or config changes. Cheap proxy with good separation: **the request names one
file and the session edits many.**
*Wrong when:* the extra edits were genuinely necessary (fixing the typo revealed a broken import), or
the user asked broadly and the scope was always wide. Needs the user's acceptance signal to separate
"overreach" from "thorough" — an unprotested wide diff is not overreach.
*Fix:* "Scope grew in 6 sessions this week. Naming the files you want touched cuts it."

### E. User friction — cheapest and highest-yield

**`user_correction`** — explicit correction, rejection, or failure report.
`LEX`+`CLS` · conf `high` · live **yes** · user-observable · data `T` · **core**
*Measure:* lexical patterns first ("no", "that's wrong", "still broken", "revert", "I already said"),
with negation and politeness handling, then a small classifier for the three validated SWE-chat
pushback categories (correction / rejection / failure report). Lexical alone gets most of the volume;
the classifier recovers paraphrase.
*Wrong when:* **"no" is the classic false positive** — "no problem", "no rush", "no, that's fine" are
not corrections. Sarcasm and understatement are missed. Non-native phrasing and terse styles ("nope",
"nah", "wrong file") need the classifier.
*Why first:* pushback appears in **45.7% of turns**, and **91.5%** of resolved misalignment episodes
involve explicit correction — the densest signal available, and the anchor that makes the
outcome-dependent dimensions resolvable at all.
*Fix:* Not surfaced alone (correcting is normal and healthy). It is the *input* that confirms other
dimensions.

**`user_interrupt`** — the user stops the agent mid-action, or denies a tool permission.
`RULE` · conf **`certain`** · live **yes** · user-observable · data `T` · standard
*Measure:* interrupt records locally; `queue_operation` subtypes (`user_prompt_discarded` et al.) in
SWE-chat.
*Wrong when:* interrupting to add information is not friction — it is steering. Only *deviation above
the 4.5% baseline* is signal, so the baseline must be reported alongside the count.
*Fix:* "You interrupt 3× more than typical on long tasks — front-loading constraints may cost less."

**`abandonment`** — the session ends unresolved and a later session restarts the same goal.
`EMB`+`OUT` · conf `medium` · live no · either-side · data `T,MS` · all
*Measure:* no convergence at `SessionEnd`, plus a later session whose opening request has high
embedding similarity to this one's.
*Wrong when:* deliberately splitting work across sessions is good context hygiene, not abandonment.
Needs the non-convergence signal to be solid, and it inherits every weakness of outcome classification.
*Fix:* "Two goals were restarted from scratch this week; both first attempts passed 70% context."

### F. Healthy patterns — credited, not merely withheld

These are the precision defence — each is the benign twin of a problem dimension, and flagging them is
how trust dies. They are also reported as **positives**, because the design doc calls for rewarding
good habits. The published taxonomies catalogue only failures, so this entire group is our own.

**`convergent_iteration`** — repeated edits that *resolve*. Benign twin of `rework_loop`.
`RULE`+`OUT` · conf `high` · live no · data `T,G` · standard
```
U: "fix the login bug"
Edit auth.ts → Test: FAIL (3) → Edit auth.ts → Test: FAIL (1) → Edit auth.ts
Test: PASS → git commit                  ← failures decreasing, ends committed
```
*Measure:* **direction** — failure count monotonically falling, terminating in a pass or a commit.
Same surface shape as rework, opposite meaning. This single discriminator is what makes `rework_loop`
shippable.
*Wrong when:* a commit without a passing test is weaker evidence of convergence than it looks.

**`tdd_fail_then_pass`** — the test was written first and failed by design.
`RULE` · conf **`certain`** · live no · data `T` · standard
*Measure:* the failing test file was created or edited immediately before the failure. Structural and
exact.

**`legitimate_debug_reread`** — re-reading while genuinely narrowing a hypothesis.
`RULE+T` · conf `medium` · live no · data `T` · standard
*Measure:* the read-set narrows over the window, and new files enter it — evidence of a search, not a
cycle.

**`exploratory_prompting`** — a vague prompt that was *meant* to be open.
`RULE`+`OUT` · conf `medium` · live no · data `T` · standard
*Measure:* no correction follows; the user accepts and builds on the answer. Matters because "make it
better" is only a defect when it leads to a miss — sometimes it is thinking out loud.

**`effective_correction`** — a correction that names the error. Twin of `vague_correction`.
`LEX` · conf `medium` · live yes · data `T` · standard
*Measure:* correction language **plus** a concrete referent — error text, file, line, or expected
behaviour. *Grounded in:* the 82,845-conversation CodeChat finding that precisely these prompts resolve
errors fastest. One of the few habits with a measurable payoff from a small, learnable change.

### G. Verification gaps

MAST's third top-level category is **Task Verification at `P 21.3%`**. The first draft had
`inaccurate_self_report` (*claiming* success falsely) but nothing for simply **never checking** — which
is both more common and easier to detect.

**`no_verification`** — code was edited and nothing was run to confirm it works.
`RULE` · conf **`certain`** · live **yes** · agent-side · data `T` · **core** · `P 21.3%`
```
U: "fix the date parsing bug"
Edit src/date.ts
A: "Done."                        ← no test, no build, no run. Nothing was verified.
```
*Measure:* edits to source files with no subsequent test / build / lint / run command before the task
or session ends. Verification commands are detected from a configurable list plus the project's own
scripts (`package.json`, `Makefile`), so it adapts per repo.
*Wrong when:* the project genuinely has no test suite; verification happened outside the session (the
user ran it in another terminal); or the change is non-functional (docs, comments). The first two are
the real precision risks and need an explicit "no verification available in this project" state rather
than a finding.
*Fix:* The most directly actionable item in the catalogue — "11 of 14 edits this week were never
verified."

**`error_ignored`** — an error appeared and the agent moved on to riskier work.
`RULE` · conf **`certain`** · live **yes** · agent-side · data `T` · standard · OpenClawBench top mass
*Measure:* non-zero exit or error output, followed by an action unrelated to fixing it.
*Wrong when:* the error was expected and irrelevant (a `grep` with no matches exits 1; a probe for an
optional file). Needs an allowlist of benign non-zero exits or it will be noisy — this is the main
work in making it shippable.
*Fix:* "Four errors were skipped past this week; two caused rework later."

**`premature_external_write`** — something left the machine before it was verified.
`RULE` · conf **`certain`** · live **yes** · agent-side · data `T,G` · standard
*Measure:* `git push`, `npm publish`, deploy, or PR creation with no passing verification beforehand.
*Wrong when:* pushing to a personal branch where CI is the verification step — legitimate and common.
Needs branch awareness to avoid scolding a normal workflow.
*Fix:* Reported as exposure, not error.

**`weak_evidence_commitment`** — a strong claim resting on thin evidence.
`JUDGE` · conf `low` · live yes · agent-side · data `T` · all
*Measure:* confident assertion with no supporting tool result. Genuinely requires a model — the
judgment is semantic. Only reaches the judge if it survives the cheap filters.
*Wrong when:* often. Broader and fuzzier than `inaccurate_self_report`, which is the strict
contradiction case. `low` confidence by construction; never surfaced ambiently.

**`capability_overcommitment`** — the agent saw it could not do the thing and pressed on.
`JUDGE`+`OUT` · conf `low` · live no · agent-side · data `T` · all
*Measure:* capability-gap or repeated-failure signals followed by escalation rather than stopping.

**`unaware_of_termination`** — the agent did not recognise it was finished.
`RULE+T` · conf `medium` · live **yes** · agent-side · data `T` · standard · `P 12.4%`
*Measure:* work continuing after the stated goal was satisfied (tests passing, request fulfilled) with
no new user instruction.
*Wrong when:* valuable unprompted follow-through — adding a test after a fix is good. Overlaps
`scope_overreach`; the two must be deduplicated or one event produces two findings.

**`fail_to_ask_clarification`** — the inverse of `clarification_churn`.
`CLS`+`OUT` · conf `medium` · live no · agent-side · data `T` · standard · `P 6.8%`
*Measure:* an ambiguous request answered with immediate broad action, followed by a user correction.
The correction is what confirms it, so it cannot be live.
*Wrong when:* the agent guessed right. Pair with `clarification_churn` so the tool can tell "you ask
too much" from "you ask too little" rather than only punishing one direction.

### H. Context mechanics — model-side vs harness-side

*Model or Harness?* supplies an **attribution axis**, not just more labels, and it changes the advice:

- **Model-side** — the information was present in context and was not used correctly.
- **Harness-side** — the information was *destroyed* by context management before use.

Harness-side findings mean *change your workflow* (compact less, move constraints to `CLAUDE.md`, start
fresh). Model-side findings mean *restate and verify*. A tool that cannot tell them apart gives the
same useless advice for both.

**`goal_drift`** *(model-side)* — attention shifts to recent context and the overarching goal is
quietly abandoned. Distinct from `constraint_decay`, which is about a specific stated rule; this is
about the *objective*.
`EMB` · conf `medium` · live **yes** · model-side · data `T` · standard
*Measure:* embedding divergence between the originating request and current work (files touched, topic
of recent turns), with no intervening user turn redirecting it.
*Wrong when:* legitimate depth-first digressions — fixing a blocker *is* pursuing the goal. The "no
intervening redirect" condition does most of the work; without it this is very noisy.
*Fix:* "Three sessions drifted from their opening request without you redirecting them."

**`context_rationale_erosion`** *(harness-side)* — compaction keeps an instruction's surface action but
drops the reasoning that justified it, so a deliberate decision gets reversed.
`RULE`+`EMB` · conf `high` · live **yes** · harness-side · data `T,PC` · standard
*Measure:* a decision honoured pre-compaction and reversed post-compaction, where the `PreCompact`
capture contains the rationale and the post-compaction context does not. The compaction boundary makes
this a *structural join*, which is why confidence is `high` despite the semantic comparison.
*Wrong when:* the reversal was intentional and user-approved after compaction.
**This is the most defensible version of "context decay", and the only dimension here no competitor
can build** — it requires capturing state before compaction summarises the evidence away. It is the
entire justification for the `PreCompact` hook.
*Fix:* The clearest harness-side advice the tool gives: "compaction dropped the reason for a decision
twice this week — put it in `CLAUDE.md` where compaction can't reach it."

**`context_saturation`** — findings clustering at high context utilisation.
`STAT` · conf `low` · live no · harness-side · data `T,MS` · all
*Measure:* correlate finding rate against context-window fill at the time of each finding, across many
sessions. Not an event detector — a per-user statistical property.
*Wrong when:* confounded with task difficulty (hard tasks run longer *and* fail more). Needs enough
sessions to be meaningful, and must be reported as correlation, never cause.
*Fix:* The most actionable single number the tool can produce for an individual — "your correction rate
triples once context passes 70%; compact earlier" — grounded in the documented attention-dilution
effect where mid-context tokens lose weight as the window fills.

### I. User-side habits — what the developer does

**The first draft missed this family entirely, which was the biggest gap in it: the product coaches the
developer, so the developer's own behaviour is the most on-mission thing it can measure — and the only
thing they can change unilaterally.**

**Prompt quality — three dimensions, each with a published effect size**, scored 0–2, each predicting a
*different* stage of success. This is the honest replacement for "prompt quality 85/100": three ordinal
ratings with published odds ratios, each separately coachable, and **computable from `history.jsonl`
alone** — which is what lets the async surface say something real about all 10 months despite the
transcript loss.

| Dimension | Scored 0–2 on | Method / conf | Published effect |
|---|---|---|---|
| **`prompt_specificity`** | goal + scope + constraints all stated | `CLS` · medium | **OR ≈ 66** on producing actionable code — strongest single predictor in any source reviewed² |
| **`prompt_verification`** | checkable criteria: examples, tests, expected behaviour | `CLS` · medium | **OR ≈ 7.8–8.5** on the output being adopted |
| **`prompt_context`** | locus of change + evidence (snippets, logs, errors) | `RULE` + `CLS` · see below | OR ≈ 2.1 on generation; **+12.5pp** on how much output survives |

*Measure:* `prompt_context` splits into two parts with **different confidence, and they must not be
reported as one number**:
- **Structural half (`RULE`, conf `high`):** does the prompt literally reference a file, path, symbol,
  error string, or code block? Exactly checkable, no model needed. This is what earns a `high` tier.
- **Sufficiency half (`CLS`, conf `medium`):** is the referenced context *enough*, given what the
  conversation already established? That is a judgment, not a rule, and it inherits the medium tier of
  its siblings.

Specificity and verification are `CLS` throughout, because both are judgments about completeness. All
three are **ordinal, not binary** — the output is a 0/1/2 distribution over time, not a pass/fail.
*Wrong when:* short follow-ups in rich context score artificially low ("now the tests" is a fine prompt
after a clear exchange). Scoring must be conversation-aware, not per-message-in-isolation — the single
most important implementation detail in this group.
*Fix:* Shows the distribution and the highest-leverage shift: "72% of your prompts score 0 on
verification — adding an expected result is the single biggest change available to you."

**`unverified_acceptance`** — the user accepted a large change without checking it.
`RULE+T` · conf `high` · live **yes** · user-side · data `T` · standard
*Measure:* a substantial diff (configurable line threshold) followed by user acceptance with no test
run, no file read, and no review turn.
*Wrong when:* the user reviewed it in their editor or IDE, which leaves no trace in the transcript.
**This is a genuine and unfixable blind spot** — so the finding must be phrased as "no verification
*visible in the session*", never as an accusation. Framing matters more here than in any other
dimension.
*Grounded in:* the trust-calibration literature on automation bias, where reliance rises precisely when
checking is costly. Nothing in the competitive landscape attempts this.
*Fix:* "You accepted 400+ line diffs without a visible check 5× this week."

**`vague_correction`** — correcting without saying what is wrong.
`LEX` · conf `medium` · live **yes** · user-side · data `T` · standard
*Measure:* correction language with **no** error text, file, line, or expected behaviour.
*Wrong when:* the context makes it obvious what is wrong, so terseness is efficient, not vague.
*Grounded in:* CodeChat (82,845 conversations) — prompts that name the mistake and explicitly request a
fix resolve errors fastest. So "it's still broken" and "the token is undefined at auth.ts:12 because
the header is read before auth runs" are not equivalent acts.
*Fix:* Side-by-side with the user's own `effective_correction` examples from the same week.

**`permission_rubber_stamping`** — approving tool permissions without reading them.
`RULE+T` · conf `medium` · live **yes** · user-side · data `T` · all
*Measure:* permission grants with near-zero deliberation time, especially for writes or shell commands.
*Wrong when:* the user already knew what was coming because they asked for it. Timing is weak evidence
and this needs a conservative threshold. Reported as risk exposure, never as a moral judgment.

**`context_hygiene`** — proactive context management.
`STAT` · conf `medium` · live no · user-side · data `T,MS` · all
*Measure:* ratio of proactive to forced compactions; `CLAUDE.md` presence and staleness; session-length
distribution; whether new goals start fresh sessions.
*Fix:* Reported as a **positive** habit score, since the doc calls for rewarding good context hygiene.

### J. Risk exposure — reported, never enforced

A published safety taxonomy organises agent actions into 9 categories (`fs_read`, `fs_write`, `shell`,
`credential`, `network`, `git`, `package`, `comm`, `meta`) across 55 atoms, split into **Tier 1
unrecoverable** (`rm -rf`, `git reset --hard`, `DROP TABLE`, `sudo`) and **Tier 2 real-but-reversible**
(`git push`, `npm publish`, deploys).

**`irreversible_action`** — Tier 1 operations performed.
`RULE` · conf **`certain`** · live **yes** · data `T` · **off by default**
*Measure:* command matching against the Tier 1 atom list.
*Wrong when:* `rm -rf` on a build directory is routine. Needs target-path awareness, or it cries wolf.

**`secret_exposure`** — credential files read, or secrets printed into transcript output.
`RULE` · conf `high` · live **yes** · data `T` · **off by default**
*Measure:* the same detectors as the redactor — reused, not reimplemented.
*Wrong when:* high-entropy strings that are not secrets (hashes, UUIDs, minified code) are the standard
false-positive class for every secret scanner.

**Scope discipline:** guardrail tools that *block* these exist and are a different product. We report
exposure retrospectively — "you approved 4 irreversible operations this week, here they are" — as a
habit the user may want to change. We never block, never warn in-flight, and never position this as a
security product. **Off by default for exactly that reason.**

### Deferred, with reason

**`spend_without_progress`** — tokens and context climbing while nothing passes or commits. In the
design doc, but **deferred**: `usage` was all zeros in the only local session containing assistant
turns, so there is no verified input on this build. Revisited against SWE-chat's `input_tokens` /
`output_tokens` columns rather than built blind. The project also explicitly rewards skill over
volume, so a token-based detector needs to be especially careful not to become a spend scold.

### Coverage check against every taxonomy reviewed

Five independent published taxonomies, all covered. The research sweep roughly doubled the catalogue —
**40 dimensions** across 10 groups — which is precisely why selection and defaults are not optional.

| Source | Scale / validation | Covered by |
|---|---|---|
| **Developer-Agent Misalignment** (EMNLP 2026) | 20,574 sessions; S1–S7, C1–C7; inter-rater 0.83 | all 7 symptoms (table below) |
| **MAST** | 200+ traces, 7 frameworks; κ=0.88; 14 modes / 3 categories | `no_verification`, `unaware_of_termination`, `fail_to_ask_clarification`, `tool_loop`, `constraint_decay` |
| **Model or Harness?** | interaction-centric; model vs harness localisation | `goal_drift`, `context_rationale_erosion`, `rework_loop`, + the attribution axis |
| **OpenClawBench** | 31,264 annotated trajectories; 5 evidence-defined classes | `error_ignored`, `weak_evidence_commitment`, `premature_external_write`, `capability_overcommitment` |
| **Prompt Quality → PR Outcomes** | stage-based, with odds ratios | `prompt_specificity`, `prompt_verification`, `prompt_context` |

| Published symptom | `P` | Covered by |
|---|---|---|
| S3 Developer Constraint Violation | 38.3% | `constraint_decay`, `repeated_instruction`, `context_rationale_erosion` |
| S2 Misread Developer Intent | 27.0% | `underspecified_prompt`, `clarification_churn`, `fail_to_ask_clarification` |
| S7 Inaccurate Self-Reporting | 22.6% | `inaccurate_self_report`, `weak_evidence_commitment` |
| S5 Faulty Implementation | 17.8% | `rework_loop`, `fail_fix_fail` |
| S1 Wrong Project Diagnosis | 11.6% | `premature_action`, `reading_spiral` |
| S4 Self-Initiated Overreach | 10.2% | `scope_overreach` |
| S6 Operational Execution Error | 2.9% | `tool_loop`, `error_ignored` |

---

## Dimension selection and config

40 dimensions is a research catalogue, not a default experience. Turning them all on would bury the
signal and guarantee a false flag on day one — the exact failure the precision principle exists to
prevent. So dimensions are **selectable, with opinionated defaults**, and the whole thing is config
driven.

### Presets

| Preset | Count | Who it's for |
|---|---|---|
| **`core`** *(default)* | 9 | High prevalence **and** high precision **and** rule-detectable. Every one is a pure rule needing no model, and each has a low false-flag ceiling. |
| `standard` | ~20 | Adds the outcome-dependent and aggregate dimensions. Needs M2 outcome classification. |
| `all` | 40 | Everything implemented, including low-confidence and experimental. |
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
