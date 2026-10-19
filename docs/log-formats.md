# Claude Code log format

What a Claude Code transcript actually contains, measured rather than assumed.

**Method.** 2,336 records across 3 catalogued sessions, read on 2026-10-15 with the parser and ad-hoc
analysis scripts. Claims are labelled **observed** (seen in this data) or **inferred** (reasoned, not
yet seen). Inferred claims get promoted or corrected when real data shows up: four have been, three
of them wrong in a way that would have produced silently bad findings.

Location: `~/.claude/projects/<slugified-cwd>/<sessionId>.jsonl`, one JSON object per line.

---

## Record inventory — observed

Every type seen, with counts across the 3 sessions:

| Type | Count | Emitted as | Notes |
|---|---|---|---|
| `attachment` | 710 | **skipped** | The most common type. Almost entirely `hook_success`; also `skill_listing`, `deferred_tools_delta`. Pure harness noise. |
| `assistant` | 601 | `assistant_msg`, `tool_use`, `tool_result` | Content is an array of blocks — flattened, one event per block. |
| `user` | 342 | `user_prompt` or `tool_result` | Content is **either** a string (a human speaking) or an array of `tool_result` blocks (the harness replying). |
| `last-prompt` | 108 | skipped | |
| `mode` | 108 | skipped | |
| `permission-mode` | 108 | skipped | |
| `atis-latch` | 107 | skipped | |
| `ai-title` | 98 | skipped | |
| `system` | 75 | `system` | Carries `subtype`, e.g. `stop_hook_summary` with `hookCount` and per-hook durations. |
| `file-history-snapshot` | 44 | `system` | **The revert signal.** `snapshot.trackedFileBackups` maps absolute path → `{backupFileName, version, backupTime}`. |
| `queue-operation` | 18 | `queue_operation` | **The interrupt signal.** `operation` is one of `enqueue`, `remove`, `dequeue`; `content` holds the mid-turn message. |
| `agent-name` | 9 | skipped | |
| `file-history-delta` | 8 | `system` | Per-file version bump, with `trackingPath`. |

Unknown types are counted and skipped, never fatal — a format change should degrade coverage, not
break the tool. Verified: 0 unknown and 0 malformed records across all 3 sessions.

## Content block types — observed

Inside an `assistant` record's `content` array:

| Block | Count | Becomes |
|---|---|---|
| `tool_use` | 285 | `tool_use` |
| `text` | 172 | `assistant_msg` |
| `thinking` | 132 | `assistant_msg` |
| `server_tool_use` | 6 | `tool_use` |
| `advisor_tool_result` | 6 | `tool_result` — this tool returns inline rather than as a separate `user` record |

Tool names observed: `Bash` (152), `Edit` (55), `WebSearch` (24), `AskUserQuestion` (18),
`WebFetch` (17), `Write` (8), `ExitPlanMode` (7), `ToolSearch`, `Artifact`, `EnterPlanMode`.

---

## Three corrections — claims that were wrong

These were all **inferred** in the original design and all three were contradicted by the data.
Each would have produced wrong findings rather than an error, which is the worst failure mode.

(A fourth inferred claim — that rewinds leave abandoned branches — was later **confirmed** rather
than corrected. It is documented below.)

### 1. File order is authoritative, not the `parentUuid` path

**The design said:** reconstruct the active leaf path, then index along it, because rewind and
compaction create abandoned branches that would otherwise double-count edits.

**Measured:** the longest path covers **1,325 of 1,695** records (78.2%). Walking it would **drop 46
real records** — 39 `tool_result`s, 5 `tool_use`s, 2 messages.

Those are not abandoned work. They are **parallel tool calls**: when the agent issues several tools
in one turn, an `assistant` `tool_use` and a `user` `tool_result` legitimately share a parent. Of 285
branch points, **zero** were rewinds.

| Branch shape | Count | What it is |
|---|---|---|
| `(attachment, user)` | 244 | an attachment sibling — noise |
| `(assistant, user)` | 39 | a parallel tool call — **both live** |
| `(user, user)` | 2 | |

**File order covers 100% and is already topologically sorted** — 0 parent-after-child violations. So
sequencing uses file order. `parentUuid` is still carried on every event, for grouping and for
detecting genuinely abandoned subtrees if a rewind ever appears.

Why this mattered: dropping `tool_result`s would have broken `no_verification`, `fail_fix_fail` and
`error_ignored` — the detectors that depend on knowing whether anything was run.

### 2. `attachment` records sit *inside* the chain, not hanging off it

Filtering attachments before walking the tree orphans every record beneath them. Measured: it turned
**1 root into 305**, and collapsed the longest path to 8 records (0.8%).

So they are traversed through and skipped only at emit time. This was caught because 305 roots in a
single session was implausible enough to re-check.

### 3. `usage` tokens are present after all

**The design said:** token data is all zeros on this build, so `spend_without_progress` has no input
and should be deferred.

**Measured: 600 of 601** assistant records carry non-zero `input_tokens` / `output_tokens`. The
original reading came from a session that was still *in progress* — its final records had not been
written yet. Token-based dimensions are therefore viable, and the deferral should be revisited.

---

## Other observed details

**`tool_use` pairs with `tool_result` by `tool_use_id`**, not by tree position. The parser keeps a
map from id → tool name so a result can name the tool it belongs to.

**Exit codes are asymmetric, and must not be inverted.** `Exit code N` appears as the first line of
`Bash` result content **only on failure** — the only value ever observed is `1`, and successful
commands carry no prefix. So a missing exit code means *"succeeded, or not a shell command"*, never
*"unknown"*. Inverting this would make `error_ignored` fire on every `Read`.

### Rewind leaves its abandoned branch in the file, unmarked — **observed**

Confirmed 2026-10-15 by rewinding a session on purpose (`11b2090d`). This was the last
significant inferred claim, and it resolved in favour of the original concern — unlike the three
corrections above.

What a `/rewind` does to the transcript:

```
line  2  user "hey how are ya?"   ──┐ ABANDONED — 3 user turns, 4 assistant
         → "jsut chilling"          │ replies, ends at line 39
         → "using this torewind"  ──┘
line 40  user "hey how are ya?"   ──┐ LIVE — continues to end of file
         → "whats this sessionId?" ─┘
```

- The pre-rewind records **remain in the file.** Nothing is truncated; no new file is created.
  (`forkSession` in the Agent SDK *does* create a new file, but that is fork, not rewind.)
- There is **no marker of any kind** — no `isRewound`, `prunedAt`, or branch flag. Abandonment is
  derivable only structurally.
- **38 of 71 records were dead** — more than half the file.
- File order remains topological (0 parent-after-child violations), so sequencing is unaffected.
- The branch point's parent was an `attachment`, reconfirming that noise records sit *inside* the
  chain and cannot be filtered before the tree is walked.

**The discriminator**, verified across 4 sessions (1 rewind, 2 resubmits, 0 false positives on 42
parallel tool calls):

> File order is topological, so the **last record in the file is on the live path**. Walk up its
> `parentUuid` chain to get the live spine. A sibling subtree hanging off that spine is abandoned
> **if it contains a human prompt** — a rewind's dead branch is a whole conversation segment, while a
> parallel tool call's sibling is a `tool_result` stub and never contains one.

A rejected earlier attempt used subtree size ("one side dies early, the other continues"). It flagged
**all 42 parallel tool calls** in a real session, because the spine runs through the `tool_use` child
while the `tool_result` child is a 3-record stub. Asymmetric subtree size *is* the parallel-call
shape.

The same rule catches a second, unrelated case found in existing data: a prompt **submitted and then
resubmitted** ~20s later with no reply in between (2 occurrences, 3 records each — a `user` record
plus hook attachments). Verified not to be the mid-turn queue mechanism: no `queue-operation` record
matches either, and there is no `isApiErrorMessage`.

Abandoned records are **flagged, not dropped** (`Event.abandoned`). Detectors ignore them by default,
but discarding them silently would hide that the work happened.

### Slash-command echoes are not prompts — **observed**

A `user` record with *string* content is usually a human speaking, but not always. These wrappers are
command echoes: `<local-command-caveat>`, `<local-command-stdout>`, `<command-name>`,
`<command-message>`, `<command-args>`, `<system-reminder>`.

**13 of 69 string-content `user` records across 3 sessions were these** — and one session
(`bc07d8cd`, a plugin install) was **8 of 8**, i.e. it had zero real prompts while appearing to have
eight. Counting them inflates prompt totals and every per-prompt rate denominator, so they are
emitted as `local_command` rather than `user_prompt`.

### Sidechains — **observed**, via a public corpus

The last inferred claim. Local transcripts had `isSidechain: false` in all 1,695 records, so subagent
handling was written to the field without ever being exercised. Two MIT-licensed public corpora
([`claude-code-log`](https://github.com/daaain/claude-code-log),
[`claude-code-sessions`](https://github.com/frederick-douglas-pearce/claude-code-sessions)) supply
**99 transcripts containing sidechains, 712 sidechain events**.

Structure: a sidechain's root record has a `parentUuid` pointing at a **main-thread** record, so a
subagent branch hangs off the spine. Some carry an `agentId`; some roots have `parentUuid: null`.

**This exposed a latent false-positive.** A subagent receives its own injected prompt, so the
abandoned-branch rule — *"a sibling subtree off the spine containing a human prompt"* — would classify
an entire fan-out as abandoned. On this corpus it happened to produce **0** false positives, but only
incidentally, which is the worst reason for something to be correct. Sidechains are now excluded
explicitly: a subagent branch was never a branch the user walked away from.

**Timestamps** are ISO-8601 UTC. Records without a `uuid` (`mode`, `last-prompt`, `file-history-*`)
cannot participate in the tree, which is a further reason not to rely on it for sequencing.

---

## Retention — why we read in place

`cleanupPeriodDays` defaults to **30 days**. Observed on the development machine: `~/.claude/history.jsonl`
listed **41 sessions** across 10 months while only **2 transcripts** remained on disk, and
`.last-cleanup` recorded a run that had removed everything older than ~2026-07-24 — including the two
largest sessions.

`history.jsonl` itself survives cleanup and holds all prompts with timestamps, project and session id.
It has no tool calls or outcomes, so it supports prompt-level analysis only.

**We do not copy any of this.** Mirroring the harness TTL would make a copy pointless, and a
transcript can contain a leaked token — duplicating it would move that liability onto us. So the
catalog tracks offsets and the sources are read in place, with the honest cost that no history exists
beyond the harness's own window. See [architecture.md](architecture.md) §1.

### Sidechain records carry no subagent id — **observed**

`isSidechain` says only *that* a record is a subagent's work, never *whose*. Measured over the public
corpus: **712 sidechain events across 90 files, and not one carries a subagent identifier.**

That matters more than it sounds. The whole reason sidechains are separated from the main thread is
that a parallel fan-out legitimately reads the same files — so if two subagents' reads are merged into
one interleaved pseudo-thread, the result reproduces exactly the `reading_spiral` false positive the
separation exists to prevent.

A subagent's work is a contiguous subtree, so the **topmost sidechain ancestor** identifies the
invocation that spawned it, and that root uuid becomes `Event.sidechainId`. After deriving it: 712 of
712 attributed, **96 distinct subagents**, 1–3 per file.

## Validating against public transcripts

Testing only against one developer's sessions is unrepresentative: one machine exercises one OS, one
version, one set of habits. `npm run verify:corpus` fetches two MIT corpora (231 transcripts) and runs
the parser over them. The corpora are deliberately **not vendored** — committing other people's
transcripts would break the same rule that stops us copying yours.

They are also deliberately **not npm devDependencies**, which was considered and rejected on
evidence: `claude-code-log` is a Python/PyPI project with no `package.json`, `claude-code-sessions`
is `private: true` with a manifest that exists only to run Prettier on its posts, and both names on
npm resolve to unrelated projects by other maintainers. Details in `scripts/corpus.json`.

**Commits are pinned.** Both upstreams are live and move, so an unpinned clone would quietly turn
every number below into a statement about whatever HEAD happened to be that morning. The pins live in
`scripts/corpus.json`; a checkout sitting at a different commit is re-checked-out rather than
accepted, and `--update` re-pins deliberately. The run is a **gate**, not a report: it exits non-zero
on count drift or on any leak.

What that run caught on its first execution, none of which local data could have surfaced:

| Finding | Local data | Public corpus |
|---|---|---|
| Harness versions | 4 (all `2.1.x`) | **42**, spanning `1.0.0` → `2.1.301` |
| Record types | 13 | **5 more** — `summary`, `cost-state`, `pr-link` (signal), `progress`, `frame-link` (noise) |
| Sidechains | 0 | **712 events across 99 files** |
| Linux home paths | 0 (macOS) | **2,414** — an untested redaction rule |
| Codex rollouts outside `.codex/` | none | **6 files** being handed to the Claude Code parser |

Three of the new record types carry real signal and were being counted as "unknown":

- **`summary`** — what compaction leaves behind, anchored by `leafUuid` to the turn it replaced. The
  reference `context_rationale_erosion` needs to tell a dropped rationale from a dropped action.
- **`cost-state`** — `totalCostUSD`, `totalLinesAdded/Removed`, durations. The lines-changed counters
  are a progress signal for outcome classification, and this is where `spend_without_progress` finally
  gets an input.
- **`pr-link`** — a pull request was opened. One of the strongest convergence signals available.

Current result: **231 files, 0 crashes, 6,019 events, 0 malformed lines**, and 0 secret shapes
surviving into any `Event` field — despite 5,926 macOS home paths, 2,414 Linux home paths, 302 emails,
2 OpenAI keys and 1 AWS key id present in the raw corpus.

**The leak claim is asserted, not inspected.** The invariant is that re-redacting anything we emit
must be a no-op; if it changes, a field reached an `Event` without passing the redactor — which is
exactly how `filePath` and `command` carried 347 raw home paths while `summarise()` looked clean.
Fields are enumerated off the `Event` object rather than from a hand-written list, so a new string
field is covered the day it appears.

Its first run flagged 10 summaries, all of which turned out to be safe: truncation cut at character
200 and the `…` marker was being absorbed by the fragment it followed, so `/home/` re-masked to
`/home/[USER]` — a path segment that was never in the source. No secret was ever exposed (redaction
runs before truncation), but the output was not stable. Summaries are now redacted to a **fixed
point**, which makes the invariant hold by construction instead of by argument.

**Version coverage is reported, not assumed.** The parser claims `2.1.x`; on this corpus that resolves
to 2 `exact`, 72 `range`, 151 `fallback` and 6 `none` (Codex, correctly refused). A fallback parse
still happens — refusing would discard data — but it is labelled.

## Codex

`~/.codex/sessions/` does not exist on this machine, and no Codex parser exists. The 6 Codex rollouts
in the public corpus are **detected and refused** rather than mangled: `session_meta`,
`response_item`, `event_msg` and `turn_context` are distinctive enough to identify by record type,
which matters because they appeared outside any `.codex/` directory.
