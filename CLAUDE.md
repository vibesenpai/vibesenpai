# agentsensei — project conventions

Read [DECISIONS.md](DECISIONS.md) before proposing an architectural change. Most decisions here were
reached by discarding a more obvious answer; the reasoning is linked from each one.

## The thesis, which is the tiebreaker for design arguments

**A sensei teaches the developer. It does not drive the agent, and it does not hand out scores.**
Every finding points at specific turns. Nothing is reported as a number without evidence behind it.

Two outputs, never a third: **evidence** and **something applicable** (a prompt, a guard, or a rule
diff). If a change would add a third kind of output — especially advice — it is out of scope.

## Local and secure: never duplicate someone else's liability

A transcript can hold a leaked token, an API key pasted into a prompt, a `.env` echoed by a tool
result. That exposure already exists in the harness's file — **copying it would create a second one**,
in a directory we chose, with a lifetime we chose, that the user never asked for. If our copy is read
by the wrong process, synced, or swept into a backup, the breach is ours, from data that was not ours
to duplicate.

Local-first usually means "nothing leaves the machine." Necessary, not sufficient: **the smallest
attack surface is the one that does not exist.**

- **Never copy raw harness data.** Read it in place, derive from it, point back at it.
- What we persist is redacted **at construction**, never redacted later.
- If a store would need `0700` plus a sync-root refusal to be safe, first ask whether it should exist
  at all. That machinery is a smell, not a solution.
- We keep no transcript copies, so we cannot offer history beyond the harness's TTL. That is the
  correct trade, and it is stated in the output rather than worked around.

## Principle Zero: a broken analyzer must never break a session

Outranks correctness of findings. A tool that costs someone a working session has done more damage
than it can repay in insight, and it gets uninstalled permanently.

- Every hook exits **0, unconditionally** (`|| true` on every command).
- Every hook has an explicit `timeout`, well under the harness budget.
- Analysis is **detached, never in-process**. A hook spawns and exits.
- The catalog is written temp-then-rename; a crash cannot leave it half-written.
- **Never open the harness's own files for writing.** We read `~/.claude/projects`.
- Circuit breaker: N consecutive failures self-disables the hook and records why.
- `AGENTSENSEI_DISABLE=1` short-circuits every hook on line one.

## Principle One: the live surface must never interrupt

The worst acceptable outcome is that a nudge goes unnoticed.

- **Statusline only.** Hook stdout goes to the *model's* context, not the user's terminal.
- Banned with no fallback: `UserPromptSubmit` surfacing, `/dev/tty` writes, OSC escape codes,
  terminal bell, any mid-session desktop notification.
- Never mid-response. Never on a session's first boundary. Rate-limited. Nudges decay.
- Nudges are **statements of fact** — no imperative verb, no severity word, no colour alarm.

## Never write the user's config

The product reads `~/.claude/settings.json` and never modifies it. Silently editing a harness config
is the S4 Self-Initiated Overreach failure this tool exists to detect.

- `doctor` **reports** the harness's retention; it does not fix it, and no longer nudges you to
  change it.
- We store **no transcript copies at all**, so there is no retention of ours to override theirs.
- Any write (hooks, statusline, `CLAUDE.md`) is printed first, consented to individually, offers
  `--print-only`, and is reversed exactly by `uninstall`.
- **Config expresses intent, never side effects.** Setting `preset: standard` does not trigger a
  download.

## Discover, do not configure

A hardcoded list of frameworks means accuracy tracks how well we guessed the user's stack. There are
thousands of toolchains; we will guess wrong. **Verification is discovered from behaviour, not named
in a list** (`src/verify.ts`):

- Output shape says a command *reports* a verdict — result vocabulary (`N passed`, `ok`, `FAIL`,
  `AssertionError`) is far more universal than command names, because every tool reports to a human.
- A command must have **executed**. Reading a test file looks identical to running one; measured, the
  first version matched `Read`, `grep expect(` and `cat >> test.ts`.
- **A verification command is one whose verdict changes when the code changes.** Seeing the same
  command both pass and fail proves it with no vocabulary at all, and it is what excludes
  `git log --oneline`, which matched on shape alone.
- What one session learns is persisted, so confidence grows with history. User config is an
  **override**, never the mechanism.

The cost is a cold start: a new project yields no findings for a session or two. That is the correct
trade — the same rule that makes `tool_loop` skip calls it cannot distinguish.

**No invisible characters in source.** A literal NUL was authored into `src/verify.ts`, and the damage
was not the constant but a doc comment holding one: a later edit targeting that comment matched
nothing, applied silently, and left a type and its implementation disagreeing while every test passed.
`test/source-hygiene.test.ts` makes it a build failure.

## Scope is a property of the detector, not of the pipeline

The window exists for a **token budget** — it is what a model can afford to read. That is a different
question from the span a *rule* should evaluate, and conflating them was a precision bug: measured
across 255 sessions, of 363 genuinely verified edits **293 (81%) are verified by a command in a later
window.** A per-window `no_verification` would have called every one of them unverified.

| scope | the question | who |
|---|---|---|
| `window` | what can a model afford to read? | semantic tier, evidence display |
| `thread` | what did **this actor** do, in order? | `tool_loop` — locality is the signal |
| `session` | did this happen **anywhere**, by anyone? | everything else |
| `project` | has this happened **before**? | `constraint_decay` — declared, refused until M3 |

`thread` is not `session`: a flat array interleaves subagent events among main-thread ones, which
breaks consecutive-run detection. `session` is not `thread`: a subagent edits a file and the main
thread runs the tests.

## Precision over recall

A false flag destroys trust permanently, and a stranger who gets one never tells you why.

- Every finding carries its **method** and **confidence**; the UI never blurs "flagged by rule" and
  "flagged by a model at 0.7".
- Thresholds are tuned to **miss rather than over-fire**, calibrated on the gold set.
- **`unknown` beats guessing.** When outcome or backend is unavailable, report absence — never infer.
  `rework_loop` fires only on `abandoned` or `reverted`, never on `unknown`.
- Ambient surfacing requires `certain` or `high`.
- No percentages on small samples — show `3 → 1`, not "+50%".
- Every problem dimension's healthy twin must work before the dimension ships.

## Working conventions

**Plan heavily; implement smoothly.** This project was fully specified before any code. That is
deliberate.

- Decisions get written down **with their evidence**, not just the verdict.
- Verify load-bearing claims against a **primary source** (a real file on disk, a paper, a registry)
  and record the check with its date.
- Label claims **observed** or **inferred**. Promote or correct inferred ones when real data arrives.
- Genuine unknowns stay open items rather than being guessed into the design.
- Reasoning travels with its conclusion. A doc that keeps verdicts and strips rationale guarantees
  the decision gets re-litigated.

## Code

- TypeScript on Node, `engines: { node: ">=22.13" }` (`node:sqlite` needs no flag from 22.13).
- **Detectors are `async`** from day one — model calls are async later.
- **No hardcoded paths.** CLI flag → env var → config file → platform default.
- `scripts/` entrypoints take paths and session id from **arguments and env**, never Claude-specific
  assumptions — the plugin layout is multi-harness by design.
- Vitest. Pinned versions. No telemetry. No network in the shipped analysis path.
- The redactor is written and tested **before** anything is stored or displayed.
- `src/catalog.ts` must never gain a file-copy path. It imports no write target under the store
  except `index.json`.

## Milestones

`PLAN.md` is authoritative. Current state: **M1 done** — catalog, parser factory, contracts,
redactor, skeletonizer, reader modes, and the `scan` / `doctor` / `config` / `skeleton` / `now` /
`report` CLI. Validated against 231 public transcripts plus local sessions; `npm run verify:corpus`
is the gate and fails on count drift or any leak.

**M2a in progress** — the first real product value: 8 outcome-free detectors, incremental
persistence, the running score. Foundation and 3 detectors land; see PLAN.md for what the first
real-data findings corrected.

**A detector is not done until its findings have been read on real data.** All three of the first
framework findings were false positives that every unit test passed — one matched a command inside a
heredoc, one mistook a denied permission for a test failure, one flagged an honest scoped report.
Counts look plausible when they are wrong; evidence does not.
