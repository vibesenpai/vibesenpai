# Did the fix work? Measuring recommendations end to end

## Context

`fix` makes one recommendation and then forgets it: nothing is stored, the user's "yes" exists only
inside the transcript, and nothing ever checks whether the dimension moved. That is the exact gap
`docs/artifacts.md:180` charges vibe-log with. The market research (`reports/agentsensei competitors
and B2B path.md`) sharpens why it matters:
- The patterns we recommend (plan mode, spec-first) have almost **no controlled outcome evidence**.
- Only Larridin and Opaline close the loop, and both centralise transcripts and score sessions.
- So agentsensei has to produce the evidence itself, from the user's own sessions, as `N → M`.
- It is also phase 0 of any B2B story ("did our enablement work?").

The data must start accruing before any graph can show anything. Transcripts expire at the harness
TTL, and we keep no copies, so every per-session fact a future rate needs must be derived and
persisted **now**, at scan time. Today it is not: denominators live only in memory (`gather.ts:335`),
`occurrence.at` is analysis time, not session time, and subagent files are counted as sessions.

**First slice (chosen): plan mode → `misread_intent`.**
- Exposure is clean and structural: `permission-mode` records, `plan_mode*` attachments,
  `EnterPlanMode`/`ExitPlanMode` tool uses.
- The outcome comes from the opt-in judge. So the denominator is **judged sessions**, every verdict
  carries `JUDGE` + `STAT`, and nothing reaches the session-start line.

## The model: three questions, not one before/after line

The unit of measurement is **per-session exposure**: was the pattern present in this session? It does
not depend on `fix` ever having been shown, so the first run backfills ~30 days of history. The
recommendation ledger is a thin layer on top that adds a `shown_at` marker.

1. **Association.** Across all history: misread intent in sessions *with* a plan step, against
   sessions *without* one. This is a within-person comparison: same person, same period, same model.
   It is the strongest evidence a single user's data can give.
2. **Adoption.** The plan-mode share of sessions before against after `shown_at`. Did they take it up?
   Did it stick? Dropping a habit is a different finding from a habit that doesn't work.
3. **Outcome.** The dimension's rate after `shown_at` against a **long baseline**: all history before
   it, not the spike that triggered the recommendation. That guards against regression to the mean.

### Honesty rules, fixed before looking at data

- **Verdict states:** `too early` · `fewer when used` · `no clear difference` · `more when used` ·
  `not comparable` · `not trackable`.
- **Minimum sample:** ≥5 judged sessions in each group. Below that, show counts only (`1 of 3`) and
  `too early`. Never percentages on small samples.
- **The test:** a one-sided Fisher exact test on the 2×2 (sessions with/without a finding ×
  exposed/unexposed), at p < 0.05. Small-n exact, ~30 lines of TypeScript, no dependency.
  Method `STAT` (already in `Method`, `types.ts`).
- **Association is not cause.** People pick plan mode for certain kinds of task, so the panel reads
  "fewer *when used*", never "plan mode reduced". It also shows median turns per group. If the medians
  differ by more than 2×, the verdict is `not comparable`.
- **Confounds are marked, not hidden:**
  - A model change appears as a marker. The dominant `message.model` is persisted per session.
  - MEMORY artifacts are compared within their project, since CLAUDE.md is per repo.
- **Guards read as suppressed, not improved** (`types.ts:394`, D23). Not used in this slice.
- **PROMPT is `not trackable`.** It lasts one session and leaves no structural trace. The panel says
  so, and points at the durable version (CONFIG/MEMORY).

## Phase 1: persist per-session facts (lands first; data only accrues forward)

**Parser: session-level facts, not new events** (`src/parsers/claude-code.ts`).
- Collect a `SessionMeta` alongside `events` before `NOISE_TYPES` are skipped:
  - `parentSessionId`, from the record's own `sessionId`
  - `models`: a count per `message.model`
  - `planUsed`
  - `planBeforeFirstEdit`: a plan step before the first edit event
  - `hookCommands`: from `stop_hook_summary.hookInfos`, redacted, **in memory only**
  - `instructionsText`: from the `instructions` attachment, **in memory only**, used to match
    MEMORY lines; never persisted, never hashed per line
- No new `Event` kinds, so event counts don't drift and `verify:corpus` stays green. Detectors see
  nothing new. Any text field kept on the meta is never placed on `Event`.

**Store** (`src/store.ts`, `src/schema.ts`: `SCHEMA.store` → 2). Additive `CREATE TABLE IF NOT EXISTS`,
matching the existing ad-hoc approach at `store.ts:303-362`.
- `session_fact`
  - Identity and time: `session_id PK`, `parent_session_id`, `is_subagent`, `first_ts`.
  - Denominators: `turns`, `edits`, `tool_calls`, `failed_calls`, `tok_out`, `tok_cache_creation`.
  - Signals: `model` (dominant id, redacted), `plan_used`, `plan_before_first_edit`.
- `intervention`: `id PK` (hash of dimension, kind, artifact key), `dimension`, `kind`,
  `artifact` (`plan-mode` · `memory:<hash>` · `hook:<hash>` · `prompt`), `first_shown_at`,
  `last_shown_at`, `shown_count`.
- `exposure`: `(session_id, artifact) PK`, `present`. Evaluated at scan time for each active
  artifact. `plan-mode` is written for every session.
- **All three are content-free:** counts, enums, booleans, hashes of *our own* artifact text. That is
  also the future team wire format. Noted, not built.

**The pass** (`scripts/compute-standing.ts:47-87`). It already parses every transcript and upserts
`session` while events are in memory.
- Also compute `countDenominators` (`src/detect/index.ts:148`) and `SessionMeta`.
- Upsert `session_fact` and `exposure` in the same transaction pattern.

**Subagent transcripts** (`read.ts:121-138` walks them as sessions, project `subagents`):
- Persist them with `is_subagent=1` and `parent_session_id`.
- Rates count **main sessions only**, and fold subagent denominators into the parent at query time.
- Recorded as a decision. Changing `standing`'s own counting is out of scope here and noted as a
  follow-up.

## Phase 2: the ledger, exposure and the verdict engine

**Record what was shown.**
- `cmdFix` (`src/cli.ts:1117`) upserts the recommendation into `intervention` after printing.
  `recommend()` is deterministic, so re-runs bump `last_shown_at` and `shown_count`, not new rows.
- `gather.ts:392` (one recommendation per dimension for the HTML report) does **not** count as shown.
- The store write is wrapped (Principle Zero): a failing store never fails `fix`.

**Artifact keys.** Add `artifactKey(rec): string | undefined` in `src/fix.ts`:
- `misread_intent` CONFIG → `plan-mode`
- a MEMORY line → `memory:<hash>`
- a hook snippet → `hook:<hash>`
- PROMPT → `prompt`, meaning not trackable

**The engine:** new `src/outcome.ts`, pure.
- Signature: `verdictFor(artifact, dimension, facts[], findings[], interventions[]) → Outcome`.
- `Outcome` holds the three questions above, each with `{exposed: n/N, unexposed: n/N}`, the
  verdict state, the p-value, medians, model-change dates and `method: ['JUDGE','STAT']`.
- The judge denominator is a session counted only when fully judged (`ledger.judged_bytes ≥
  size_bytes`) and not a subagent file.
- Time comes from `session_fact.first_ts`, never `occurrence.at`.

**Feeding back into `fix`.**
- `recommend()` gains an optional `outcomes` input.
- When the user's own data supports the pattern, the evidence line uses it: *"misread intent in 1 of 7
  sessions that planned first, 6 of 9 that did not"*.
- When the verdict is `no clear difference` at full sample, it says so instead of re-pushing.
- Escalating to a stronger rung is wired only where one exists; plan mode has none, and the text
  says that.

## Phase 3: trends and the report (gated; the charts are approved before they are wired)

Two layers, both drawn from the same persisted tables, so both extend past the harness TTL:

- **Trends: every dimension over time.** This is D4's running score made visible, and it doesn't
  depend on any fix having been shown.
- **Did it work?: one panel per artifact that was recommended.** It sits on top of its dimension's
  trend.

### Trend series (new `src/trends.ts`, pure)

- Weekly buckets keyed on `session_fact.first_ts`.
- Each dimension uses its own denominator:

  | dimension | rate | unit |
  |---|---|---|
  | `edit_retry` | findings per edit | per 100 edits |
  | `redundant_call` | findings per tool call | per 100 tool calls |
  | each judge dimension | sessions with ≥1 finding per judged session | sessions, labelled "flagged by a model" |
  | cost metadata (cache creation per output token) | — | shown as metadata, never a finding (D50) |

- Each point carries `n/N`.
- A week below the minimum denominator is drawn hollow and labelled "too few". The rate is never
  extrapolated.
- Markers overlaid on every series: `fix shown` (from `intervention`), adoption share (from
  `exposure`), model changes (from `session_fact.model`), and a "suppressed from here" band when a
  guard is active.
- Deltas use the running-score language already designed (`surfaces.md:519`): since the previous
  window and since the first recorded session, on rates, with `n → m` below the minimum.

### Surfaces

- **`/agentsensei:report` (HTML, `src/html.ts` + `src/gather.ts`):**
  - **Findings section:** each dimension's existing `<details>` gains an inline trend chart (a small
    inline SVG, one unit per axis) under its headline. If a recommendation for that dimension was
    shown, its "Did it work?" panel follows directly below. The finding, its history and its outcome
    then read top to bottom in one place.
  - **A new top-level "Trends" section** after the four figures: all dimensions as small multiples
    on a shared time axis, each with its own y unit. One glance answers "which way is everything
    going?", and each multiple links down to its Findings drill-down.
  - `gather.ts` today recomputes from live transcripts only (`--last`/`--since`). The trend data comes
    from `session_fact` + `occurrence`, so the report's history is no longer capped by what is still
    on disk. The current-window figures remain live.
  - Rendering: server-side inline SVG, no JS, CSP-safe (`test/html.test.ts`), existing tokens and
    dark mode, readable at phone width.
- **`agentsensei trends`** (`cli.ts:175` stops listing it as unimplemented): the same series as a
  plain-text weekly table, then the "Did it work?" blocks. No bars, matching `render.ts`.
- **`/agentsensei:insights` / `standing`:** one delta per dimension in words ("edit_retry 9 → 4 per
  100 edits since last window"), no chart.

### Mockups (approved before wiring; built first as a standalone preview page)

Trend, inside a dimension's drill-down:

```
edit_retry · per 100 edits                                    since Sep 1
 9 ┤ ●                                                        ┆ fix shown
 6 ┤    ●     ●  ┆                                           ╎ model changed
 3 ┤       ●     ┆   ●    ○      ●   ╎  ●                     ○ too few edits
 0 ┼──────────────────────────────────────────
    Sep 1      Sep 15      Oct 1      Oct 15     Oct 25
 Since last window   9 → 4 per 100 edits  ·  since Sep 1   7 → 4
```

The "Did it work?" panel for the first slice:

```
misread_intent · judged sessions · flagged by a model            past 30 days
 ●  without a plan step       ○  with a plan step                ┆ fix shown   ╎ model changed

 misread ┤ ●        ●     ┆                ●
 none    ┤ ○  ●  ○     ●  ┆  ○  ○  ○   ●  ╎  ○  ○  ○
          Sep 26          Oct 12          Oct 18      Oct 25

 With a plan step     1 of 7  ·  median 14 turns
 Without              6 of 9  ·  median 11 turns
 Verdict              fewer when used   (exact test, p=0.03 · association, not cause)
 Adoption             plan step in 2 of 11 sessions before Oct 12, 7 of 13 after
```

- **`/agentsensei:fix`**: the evidence line above. `commands/fix.md` is unchanged.
- **Session-start line: nothing in this slice.** Judge-based findings can't be ambient. A rule-based
  artifact can add a single fact line later (no imperative, rate-limited, D57-scoped).

## Phase 4: decisions and docs

New entries in `DECISIONS.md`, each with its evidence and linked from the entries it qualifies:
- **D65.** The loop returns, measured by **exposure**, not by date. Qualifies "Coaching layer →
  Artifacts, no advice" (it still outputs artifacts, not advice) and "before/after as headline".
  Evidence: the research report's finding that no rival checks outcomes locally, and that the
  patterns lack outcome evidence.
- **D66.** A verdict is `STAT` metadata over findings, never a finding or a score. Consistent with D50.
- **D67.** One-unit charts are allowed in the HTML report. Qualifies `html.ts:47-52`, whose objection
  was mixed units on one axis.
- **D68.** Subagent transcripts are not sessions for rates.

Also: update `docs/artifacts.md` (the loop section is now built), `docs/surfaces.md` (trends), and
the PLAN/CLAUDE.md milestone line.

## Critical files

- `src/parsers/claude-code.ts`, `src/types.ts`: `SessionMeta` on the parse result; `Event` untouched.
- `src/store.ts`, `src/schema.ts`: three tables, schema v2.
- `scripts/compute-standing.ts`: persist facts and exposure.
- `src/outcome.ts` (new), `src/fix.ts` (`artifactKey`, `outcomes` input), `src/cli.ts` (`cmdFix`
  write, `trends`).
- `src/trends.ts` (new, the weekly series and deltas), `src/html.ts`, `src/gather.ts`: the Trends
  section, the per-dimension inline charts and the "Did it work?" panels.
- Reused as-is: `countDenominators` (`detect/index.ts:148`), `spanOf`, `redact` (`src/redact.ts`),
  `transact`/`openStore`, `readJudgedFindings` (`judge-store.ts:313`), the ledger table.

## Verification

1. **Parser fixtures.** A JSONL fixture with `permission-mode`, `plan_mode` attachments,
   `message.model`, `stop_hook_summary` and `instructions`. Assert the `SessionMeta` values, and that
   the event list is **identical** with and without the change.
2. **Corpus gate.** `npm run verify:corpus` passes, with no count drift and no leaks. `npm test`
   and `tsc` pass. `test/source-hygiene.test.ts` stays green.
3. **Store.** Migration from a v1 `store.db`. Re-running the pass is idempotent. Verify the new tables
   hold no content: column-type and length assertions, plus a `redact(x) === x` check on string
   columns.
4. **Verdict engine, synthetic data:**
   - small n → `too early`, with counts and no percentage
   - a clear effect → `fewer when used`
   - a regression-to-the-mean scenario: a spike then a natural decline, no adoption → *not* "fewer"
   - size mismatch → `not comparable`
   - a model change marker appears
   - PROMPT → `not trackable`
5. **Real data, read by eye** (the CLAUDE.md rule):
   - Run `compute-standing` on local sessions.
   - Hand-check plan-mode exposure against several transcripts.
   - Read every verdict the engine produces and confirm each count traces to sessions.
6. **Trend series.** Synthetic unit tests: sparse weeks are drawn hollow, rates use the right
   denominators, deltas give `n → m` below the minimum, and a dimension's history survives its
   transcripts being deleted (facts only, no files).
7. **UI.** Render the HTML report and open it. Check light/dark, phone width, and the CSP test
   (`test/html.test.ts`).
