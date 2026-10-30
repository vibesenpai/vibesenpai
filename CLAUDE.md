# agentsensei — project conventions

Read [DECISIONS.md](DECISIONS.md) before proposing an architectural change: most decisions here were
reached by discarding a more obvious answer, and the reasoning is linked from each one.
Area-specific rules load from `.claude/rules/` when you touch those files.

- Rules learned from your own sessions: .claude/rules/agentsensei.md

## The thesis, which breaks ties in design arguments

**A sensei teaches the developer. It does not drive the agent, and it does not hand out scores.**
Every finding points at specific turns. Nothing is reported as a number without evidence behind it.

Two outputs, never a third: **evidence** and **something applicable** (a prompt, a guard, or a rule
diff). A change that would add a third kind of output, especially advice, is out of scope.

## Local and secure: never duplicate someone else's liability

A transcript can hold a leaked token or a pasted API key. That exposure already exists in the
harness's file; copying it would create a second one, in a place and for a lifetime we chose.

- **Never copy raw harness data.** Read it in place, derive from it, point back at it.
- What we persist is redacted **at construction**, never redacted later.
- If a store would need `0700` plus a sync-root refusal to be safe, first ask whether it should exist.
- We keep no transcript copies, so we offer no history beyond the harness's TTL, and say so.

## Principle Zero: a broken analyzer must never break a session

Outranks correctness of findings.

- Every hook exits **0, unconditionally** (`|| true`), and has an explicit `timeout` well under budget.
- Analysis is **detached, never in-process**. A hook spawns and exits.
- State files are written temp-then-rename (`src/files.ts`).
- **Never open the harness's own files for writing.** We read `~/.claude/projects`.
- Background jobs heal at the next hook: a dead or hung pass is reclaimed, failures back off and
  retry, and repeated *paid* failures hold the judge. See `.claude/rules/hooks.md`.
- `AGENTSENSEI_DISABLE=1` short-circuits every hook on line one.

## Principle One: the live surface must never interrupt

The worst acceptable outcome is that a nudge goes unnoticed.

- Surface only through **`systemMessage` at session start**. It reaches the user, not the model.
  **Never emit `additionalContext`**: that would put the tool inside the session it measures.
  Plain hook stdout goes to the model's context; never surface through it.
- No statusline (see GRAVEYARD.md), no `UserPromptSubmit` surfacing, no `/dev/tty`, OSC codes, bell
  or mid-session notifications.
- Never mid-response, never on a session's first boundary. Nudges are **statements of fact**: no
  imperative verb, no severity word, no colour alarm.

## Never write the user's config

The product reads `~/.claude/settings.json` and never modifies it; silently editing a harness config
is the Self-Initiated Overreach this tool exists to detect. The plugin is the only way in (D64).
Config expresses intent, never side effects.

## A detector reads structure; the compiler enforces it

`DetectorContext.events` is `StructuralEvent[]`, which omits command and message text, so reading
text in a detector is a build failure. Three text-based detectors produced 5 true positives against
~25 false positives on 1,139 real sessions (GRAVEYARD.md). Details: `.claude/rules/detectors.md`.

**A mechanism is not a behaviour.** A probe over a harness mechanism must first establish that the
mechanism means what its name suggests. Five probes failed this (see docs/findings-frequency.md).
A threshold-defined frequency is tautological: "above p90" reports ~10% by construction.

**`unknown` beats guessing**, and it is a first-class answer. Where structure is absent (e.g. a
pipeline's exit status belongs to `tail`), downgrade confidence or say nothing; never read the text.

## Precision over recall

A false flag destroys trust permanently.

- Every finding carries its **method** and **confidence** in the data. The UI does not show how a
  finding was flagged: that it was flagged is what matters to the user (decided 2026-10-28).
- Thresholds are tuned to miss rather than over-fire. Ambient surfacing requires `certain` or `high`.
- An unrecognised harness reason reads as "reason unknown", never as the nearest familiar one.
- No percentages on small samples: show `3 → 1`, not "+50%".
- **A detector is not done until its findings have been read on real data.** Counts look plausible
  when they are wrong; evidence does not.

## Working conventions

- **Plan heavily; implement smoothly.** Decisions are written down with their evidence.
- Verify load-bearing claims against a primary source, and record the check with its date.
- Label claims **observed** or **inferred**; promote or correct inferred ones when data arrives.
- Genuine unknowns stay open items rather than being guessed into the design.
- **Comments are short and factual.** Rationale lives in a doc and the comment links to it.
  See `.claude/rules/comments.md`.

## The judge sends session content to a model, on fixed terms

Full terms: `.claude/rules/judge.md`. The two that must never slip:

- **Redacted at construction, asserted before every call:** `redact(packet) === packet` or the send
  aborts (`wouldLeak`).
- **The child is isolated:** `AGENTSENSEI_DISABLE=1` and a working directory our own discovery skips.
  It is spent only by the `Stop` hook; no command spends, except `judge --backlog --apply`.

## Code

- TypeScript on Node `>=22.13`, run directly with `--experimental-strip-types`. No build step.
- Vitest. Pinned versions. No telemetry. No network in the analysis path, **except the judge**.
- Detectors are `async`.
- **No hardcoded paths.** CLI flag → env var → config file → platform default.
- `scripts/` entrypoints take paths and session id from arguments and env, never Claude-specific
  assumptions.
- `tsconfig` covers `src/`, `test/` and `scripts/`.
- **Every published frequency comes from `npm run measure`**, over the pinned corpus.
- `npm run verify:corpus` is the gate: it fails on count drift or any leak.
- No invisible characters in source (`test/source-hygiene.spec.ts`). A `//` comment that mentions the
  `ts-expect-error` directive is one.

## Layout

- `src/cli.ts` dispatches to `src/cmd/*.ts`, one file per command.
- `src/detect/`: detectors and reason labels. `src/parsers/`: transcript → `Event[]`.
- `src/judge/`: the model pass (packet, prompt, model call, state, schedule, lock, run).
- `scripts/hook-*.ts`: the two hooks. `scripts/judge.ts` and `scripts/compute-standing.ts`: the
  detached passes they spawn.
- Current state: CHANGELOG.md. `PLAN.md` is history up to M2a.
