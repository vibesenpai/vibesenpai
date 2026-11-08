---
paths:
  - "src/judge/**"
  - "scripts/judge.ts"
  - "scripts/judge-control.ts"
  - "scripts/gold*.ts"
  - "src/redact.ts"
---

# The judge may send session content, and only on these terms

The structural tier is exhausted; the rest is detected from developer pushback in the chat
(arXiv 2605.29442). So the judge invokes the **local harness CLI** (`claude -p`): no API key, no
model download, no telemetry.

- **On by default, spent only by the Stop hook.** `DEFAULT_SETTINGS.enabled` is `true`, because
  `/plugin install` is the deliberate act (commit c9b11fe). The `Stop` hook is the only automatic
  spender; no command spends, except `judge --backlog --apply`. `judge --disable --apply` turns it off.
  `test/spend-boundary.spec.ts` pins this.
- **Redacted at construction, asserted before every call.** `redact(packet) === packet` or the send
  aborts (`wouldLeak`). About half of real sessions carry secret-class content.
- **Batched, accounted in tokens and dollars.** ~26k tokens of invocation overhead per call dwarf a
  typical session, so sessions share a call. Each call's tokens and Claude Code's own dollar figure
  (`total_cost_usd`) are recorded in `spend` and on the `run` row. Dollars are shown as API prices:
  on a subscription they are plan usage, not a bill.
- **Limited when automatic** (`src/judge/limits.ts`). The Stop hook's pass gets `VIBESENPAI_LIMITS=1`
  and stops at `dailyTokens` (default 2M, per local day) and at a one-time catch-up of `catchUp`
  (default 200) never-read past sessions, newest first; the cutoff is stored once in `meta`.
  Explicit runs (`judge --backlog --apply`, `tick --judge`) and benchmarks are never limited.
- **Disclosed before the first spend:** the one-time session-start notice states the figures and
  the off switch (`/vibesenpai:judge off`).
- **The child is isolated.** `VIBESENPAI_DISABLE=1` and a dedicated working directory that
  `discoverTranscripts` filters out, so the judge never reads its own sessions.
- **A finding that cannot quote the packet is discarded.** `method: 'JUDGE'` is kept in the data; the
  UI does not show how a finding was flagged (CLAUDE.md, "Precision over recall").
- **Lookback** (`src/judge/lookback.ts`, on by default): a `misread_intent` or `constraint_violation`
  must cite where the expectation was set before the agent acted (an earlier prompt, a loaded
  instruction, or the developer's own reference to an earlier decision). The gate checks the quote
  against what was sent and drops the rest as suggestions; `run.gated` counts them.
- **Secondary kinds:** a label may add up to `SECONDARY_MAX` more kinds (`secondary_dimensions`), as
  the paper multi-labels. `dimension` stays in charge of the gate, ids and the fix; the gold scorer
  counts each kind as a claim and also prints the main-kind-only score for comparison.
  `caughtAnyKind` is the primary recall: an episode caught at the right place under any of the four
  kinds counts, because the kinds overlap and the paper's labels are partly subjective.
- **Developer commands are developer turns.** Each harness's parser marks them with the neutral
  `Event.devCommand` (`invocation` or `instructions`); the packet reads only that field, never a
  harness's tags. The invocation (`/name args`) and up to `COMMAND_BODY_MAX` of its instructions, once
  per packet. A skill the agent loaded itself is never marked. A skipped step of a command's
  procedure counts only if the developer objected or the outcome changed (the extract rules).
- Two stages (extract, then label) is the paper's architecture: 165/232 against 129/232 for one pass
  (docs/eval.md). Changing the rubric invalidates that measurement.
