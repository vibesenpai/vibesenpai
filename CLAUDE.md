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

- **`systemMessage`, at session start only.** A hook returning `{"systemMessage": …}` renders in the
  *user's* main window and reaches the model not at all — established from Anthropic's own plugins,
  not the docs: `claude-security` prints an ASCII logo through it, and `security-guidance` calls it a
  *"user-visible TUI message"*, distinct from `hookSpecificOutput.additionalContext`, which it
  describes as reaching "both the model and the user". **We never emit `additionalContext`** — that
  would put the tool inside the session it measures.
- **Plain hook stdout goes to the *model's* context**, not the terminal. Never surface through it.
- The statusline was tried and removed: a permanent row of screen for one rarely-changing line, and
  **no official plugin ships one**. See `GRAVEYARD.md`.
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

## A detector reads structure. The compiler enforces it.

```ts
export type StructuralEvent = Omit<Event, 'command' | 'pattern' | 'textSummary'>;
```

`DetectorContext.events` is `StructuralEvent[]`, so reading command text in a detector is a **build
failure**, not a review comment. This is the project's central rule and it was bought expensively:
three detectors shipped on text and, across 1,139 real sessions, produced **5 true positives against
~25 false positives**. `GRAVEYARD.md` has each one with the evidence that killed it.

Text is an open space. There are thousands of toolchains and infinite phrasings, so a rule over text
is a guess with good manners — it cannot even tell you what it missed.

**A harness string may name a finding; it may never produce one.** `src/detect/labels.ts` maps the
harness's own reasons to advice, and the **runner** applies it after a detector has already produced
a valid candidate. The dependency runs one way: reword a message and `reasonOf` returns `undefined`,
the finding still fires, the report says the reason is unknown. Losing a label is cosmetic; losing a
detection would be silent.

**The format has no error codes** — verified across all 5,354 failing results; every one is a plain
string. What it does have is an *envelope*, and the envelope is structure:

```
<tool_use_error>…</tool_use_error>   the tool itself refused        1424
The user doesn't want to proceed…    the person said no             398
Sibling tool call errored            the call never ran             113
PreToolUse:Edit hook error: …        the person's OWN hook blocked   45
```

`Event.failureKind` records that distinction, derived in the harness-specific parser where harness
coupling belongs. Detectors read an enum. Telling someone their own hook is waste would be worse
than saying nothing.

**No invisible characters in source.** A literal NUL was authored into `src/verify.ts` (since deleted), and the damage
was not the constant but a doc comment holding one: a later edit targeting that comment matched
nothing, applied silently, and left a type and its implementation disagreeing while every test passed.
`test/source-hygiene.test.ts` makes it a build failure.

Related, and the same lesson: a `//` comment *mentioning* `@ts-expect-error` **is** one. Explaining
that guard in prose created a fourth directive and a confusing build error.

## A mechanism is not a behaviour

**A probe over a harness mechanism must first establish that the mechanism means what its name
suggests.** Five instances, each of which looked authoritative until broken down:

| claimed | what it actually counted |
|---|---|
| `user_interrupt`, 64% of sessions | **3,504 of 3,606 enqueues sit at a turn boundary**; 1,858 are `<task-notification>` |
| `prompt_withdrawn`, 37% | `remove`/`popAll` carry empty content; the queue operations balance |
| `error_ignored`, 62% | of 234 matches, **≥68 were the agent fixing** and 55 investigating |
| `premature_external_write`, 38% | every push, including to a personal branch where CI is the gate |
| cache hit rate, 97.7% | `cache_read` re-counts the whole prefix per call, so `read/(read+creation)` runs **p10 0.901 → p90 0.985** whatever anyone does |

Two softer forms of the same error, both caught by making the numbers reproducible: *signal
availability is not frequency* (84% of sessions carry file-history records; 11% have file churn), and
**a threshold-defined frequency is tautological** (a probe asking "above p90" reports ~10%).

## Scope is a property of the detector, not of the pipeline

The window exists for a **token budget** — it is what a model can afford to read. That is a different
question from the span a *rule* should evaluate, and conflating them was a precision bug: measured
across 255 sessions, of 363 genuinely verified edits **293 (81%) were covered by a command in a later
window.** A per-window rule would have called every one of them unverified.

| scope | the question | who |
|---|---|---|
| `window` | what can a model afford to read? | semantic tier, evidence display |
| `thread` | what did **this actor** do, in order? | `redundant_call` — locality is the signal |
| `session` | did this happen **anywhere**, by anyone? | everything else, incl. `edit_retry` |
| `project` | has this happened **before**? | `constraint_decay` — declared, refused until M3 |

`thread` is not `session`: a flat array interleaves subagent events among main-thread ones, which
breaks consecutive-run detection. `session` is not `thread`: a subagent edits a file the main thread
then retries.

**A span also ends at the next user prompt.** A new instruction is a new request, so what the agent
does afterwards does not belong to what came before. It is the one bound that is a fact about the
session rather than a guess about attention — which is why `edit_retry` uses it and does *not* also
cap the gap at N turns.

## What survives a pipe

Structure is best where it exists, and simply absent where it does not. Measured: **111 of 127
verdict-bearing results come from pipelines**, so the exit status belongs to `tail` rather than to the
test runner. A self-truncating command (`tsc --noEmit 2>&1 | head -30`) throws its own output away
*upstream of us*, so even an output digest compares a prefix.

The honest responses are to downgrade confidence or to say nothing. The dishonest one is to read the
text instead, which is how this project spent most of a week.

**`unknown` beats guessing**, and it is a first-class answer rather than a gap to paper over.

## Precision over recall

A false flag destroys trust permanently, and a stranger who gets one never tells you why.

- Every finding carries its **method** and **confidence**; the UI never blurs "flagged by rule" and
  "flagged by a model at 0.7".
- Thresholds are tuned to **miss rather than over-fire**, calibrated on the gold set.
- **`unknown` beats guessing.** When outcome or backend is unavailable, report absence — never infer.
  An unrecognised harness reason reads as "reason unknown", never as the nearest familiar one.
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
- Vitest. Pinned versions. No telemetry. No network in the shipped analysis path,
  **except the judge** — see below.

- `tsconfig` covers `src/`, `test/` **and `scripts/`**. It did not, and the reset silently broke
  `npm run measure` while every check stayed green.
- **Every published frequency comes from `npm run measure`**, over the pinned corpus, so a number in
  a doc can be reproduced instead of trusted. A built dimension is measured by its own detector and
  never by a probe that resembles it.
- The redactor is written and tested **before** anything is stored or displayed.
- `src/catalog.ts` must never gain a file-copy path. It imports no write target under the store
  except `index.json`.

## The judge may send session content, and only on these terms

The structural tier is exhausted: Edit and Write are 998 of ~1,400 tool
refusals and both are covered by `edit_retry`. The research this project's
dimension table comes from ([arXiv 2605.29442](https://arxiv.org/abs/2605.29442),
20,574 sessions) found the rest is detected from developer pushback in the chat
logs, **"not on structural signals such as tool-call errors, exit codes, or test
failures."** We proved it the expensive way: `inaccurate_self_report` is their
S7, was built here on rules, and died 0 true positives against 5 false.

So the analysis path may invoke the **local harness CLI** — no API key, no
model download, no telemetry — and that is a real amendment to the line above,
not a technicality. It is bounded by five rules, every one of which exists
because something was measured:

- **Off until enabled by an explicit act.** `judge --enable --apply`, the same
  shape as `install`. A detached process that spends someone's money unprompted
  is the Self-Initiated Overreach this tool exists to detect.
- **The payload is redacted at construction, and that is asserted immediately
  before the call.** `redact(packet) === packet`, or the send aborts. Measured:
  **50% of sessions carry secret-class content** at full fidelity —
  `secret-assignment`, `api-key`, `jwt`, `url-credentials`, `bearer` — and tool
  output is where they concentrate. A warning would not do; a warning in a
  detached process is a thing nobody reads.
- **Batched, and accounted for in tokens.** ~27,000 tokens of invocation
  overhead dwarf a ~9,000-token session, so N sessions go in one call. Usage is
  recorded and `doctor` prints it. Never dollars — see the note on prices.
- **The child is isolated.** `AGENTSENSEI_DISABLE=1` and a dedicated working
  directory that `discoverTranscripts` filters out. `--bare` would be better
  but demands `ANTHROPIC_API_KEY` and silently returns "Not logged in" on a
  subscription. Measured the hard way: three probe calls took one machine from
  9 discovered sessions to 12.
- **A model finding never blurs into a rule finding.** `method: 'JUDGE'`
  renders as *"flagged by a model"*, and a finding that cannot quote the packet
  is discarded on the way out.

## Milestones

`PLAN.md` is authoritative. Current state: **M1 done** — catalog, parser factory, contracts,
redactor, skeletonizer, reader modes, and the `scan` / `doctor` / `config` / `skeleton` / `now` /
`report` CLI. Validated against 231 public transcripts plus local sessions; `npm run verify:corpus`
is the gate and fails on count drift or any leak.

**M2a in progress, restarted 2026-10-19.** The three original detectors are deleted — see
`GRAVEYARD.md`. `edit_retry` is the first replacement and the first detector in this project's
history to produce a real finding: **380 of 1,139 sessions (33.4%)**, 927 instances, every one
`certain`, 926 of 927 labelled with the harness's own reason.

Next, in order of how clearly each can point at a turn: `file_churn`, `context_reingest`,
`redundant_call`. Still unbuilt and deliberately so: `permission_denied` (18.1% and now structural, but
declining is the person exercising control and it is not obvious it should ever be surfaced) and
`user_correction` (needs parser work — 45% of prompts hit the 200-char cap).

**A detector is not done until its findings have been read on real data.** This is the only check
that has ever caught anything here.

- The first three framework findings were all false positives that every unit test passed — one
  matched a command inside a heredoc, one mistook a denied permission for a test failure, one flagged
  an honest scoped report.
- `edit_retry` passed every test and still mis-paired verdicts with calls, because **tool-call ids
  are not unique**: one pinned-corpus file reuses 90 of them. Reading the evidence showed a verdict
  at seq 627 answering an edit at seq 628, which cannot happen.

Counts look plausible when they are wrong; evidence does not.
