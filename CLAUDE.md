# agentsensei — project conventions

Read [DECISIONS.md](DECISIONS.md) before proposing an architectural change. Most decisions here were
reached by discarding a more obvious answer; the reasoning is linked from each one.

## The thesis, which is the tiebreaker for design arguments

**A sensei teaches the developer. It does not drive the agent, and it does not hand out scores.**
Every finding points at specific turns. Nothing is reported as a number without evidence behind it.

Two outputs, never a third: **evidence** and **something applicable** (a prompt, a guard, or a rule
diff). If a change would add a third kind of output — especially advice — it is out of scope.

## Principle Zero: a broken analyzer must never break a session

Outranks correctness of findings. A tool that costs someone a working session has done more damage
than it can repay in insight, and it gets uninstalled permanently.

- Every hook exits **0, unconditionally** (`|| true` on every command).
- Every hook has an explicit `timeout`, well under the harness budget.
- Analysis is **detached, never in-process**. A hook spawns and exits.
- The archive is append-only and content-hashed; a crash leaves at worst a partial trailing record.
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

- `doctor` **reports** the retention risk; it does not fix it.
- Any write (hooks, statusline, `CLAUDE.md`) is printed first, consented to individually, offers
  `--print-only`, and is reversed exactly by `uninstall`.
- **Config expresses intent, never side effects.** Setting `preset: standard` does not trigger a
  download.

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

## Milestones

`PLAN.md` is authoritative. Current state: **M0 — spec split (done), archiver next.** First real code
is **M2a**: 8 outcome-free detectors, incremental persistence, the running score. That is the first
point the product exists.
