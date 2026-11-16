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

- **Off until a yes given after a preview; spent only by the Stop hook** (DECISIONS.md D72).
  `DEFAULT_SETTINGS.enabled` is `false`. Every spender checks `readsOn` (`enabled` and a `consent`).
  Consent is written only by `giveConsent`, which refuses without a preview built in the last hour
  (`markPreviewShown`); the yes comes from `/vibesenpai:judge yes` or the pane's **Turn on**, never
  from a hook, a pass or text the agent read. `--disable --apply` turns reads off and forgets the yes.
  The preview (`src/judge/preview.ts`) reuses `planRound`/`packBatches` with `dry`, records nothing
  but the hash marker, and calls no model. The `Stop` hook is the only automatic spender; no command
  spends, except `judge --backlog --apply`. `test/spend-boundary.spec.ts` pins this.
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
- **Said once while paused:** the session-start notice states that reads are paused, nothing has
  been sent, what they would do and the figures, and where the preview is. It is a fact, not a
  question. The terms of a yes (how long it lasts, what it costs) live in `src/judge/terms.ts` and are
  shown wherever a yes is asked for.
- **Every call is recorded, never copied** (DECISIONS.md D73). `logSent` writes one `sent` row per
  call: recipes (step 1) or composition (step 2), sizes, tokens, cost, `REDACT_VERSION` and the
  SHA-256 of the exact packet. `rebuildSent` re-cuts step 1 from the transcript and checks the hash.
  Bump `REDACT_VERSION` with any change to the redaction rules (a test pins the pair).
- **The child is isolated.** `VIBESENPAI_DISABLE=1` and a dedicated working directory that
  `discoverTranscripts` filters out, so the judge never reads its own sessions.
- **A finding that cannot quote the packet is discarded.** `method: 'JUDGE'` is kept in the data; the
  UI does not show how a finding was flagged (CLAUDE.md, "Precision over recall").
- **Lookback** (`src/judge/lookback.ts`, on by default): a `misread_intent` or `constraint_violation`
  must cite where the expectation was set before the agent acted (an earlier prompt, a loaded
  instruction, or the developer's own reference to an earlier decision). The gate checks the quote
  against what was sent and drops the rest as suggestions; `run.gated` counts them, and each drop is stored in
  `gated` (redacted at construction, like findings' quotes) so a missed failure can be read: `judge --gated`.
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
