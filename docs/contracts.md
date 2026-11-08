# Pinned contracts & storage

## Contracts to pin before implementation

Most structure should be designed while implementing. **The exception is anything written to disk and
read back later** — if its shape changes, previously stored data becomes wrong, and the migration is
worse than the design. Three contracts qualify. Everything else (catalog file naming, detector
internals, CLI formatting, table indices) is deliberately deferred.

### 1. Evidence references — by `uuid`, never by position

A finding points at turns, and those pointers must survive a re-parse.

```ts
type TurnRef = {
  uuid: string;        // the transcript record's own uuid — the ONLY stable identifier
  seq?: number;        // position along the active leaf path, for display only
  sessionId: string;
};
```

**This is a correctness decision, not a detail.** `seq` is a position on the *active leaf path*, and
the path changes when a rewind or compaction alters which branch is live. A finding stored as
"turns 31, 44" silently points at different turns after the next rewind. `uuid` comes from the
transcript itself and never moves. `seq` is recomputed for display on every read and never persisted
as the identity.

### 2. Finding identity — keyed on *subject*, not on evidence extent

The anti-nag rules ("never repeat a finding"), `dismiss --wrong`, and the surfaced-flag all depend on
a finding having a stable identity across runs.

```ts
findingId = hash(dimension + sessionId + subject)   // this session's instance
subjectId = hash(dimension + project   + subject)   // the same thing, across sessions
```

where `subject` is **the thing the finding is about** — the constraint text, the file path, the
command, the claim — and explicitly **not** the turn range.

**Two keys, because three features need the cross-session one.** `findingId` identifies an instance
inside one session; `subjectId` recognises *the same subject recurring across sessions*, which is
what the running score, dismissals, and the `CLAUDE.md` audit all actually operate on:

- The score says *"`constraint_decay` 'use pnpm' ×2, ↓20%"* — an aggregate over sessions, impossible
  to compute from per-session ids alone.
- `dismiss --wrong` must persist. Keyed per session, a dismissed finding returns next session, which
  is precisely the re-nagging the anti-nag rules forbid.
- `constraints.violations` accumulates per rule over time; that history is the audit's entire input.

`project` rather than `sessionId` is the right scope: "use pnpm" in a different repo is a different
subject, not a recurrence.

**Why this matters more than it looks.** Keying on the evidence range would fragment findings as
evidence accumulates: `constraint_decay` with 7 violations becomes a *different* finding when an 8th
appears, so a user who dismissed it gets re-nagged, and the nudge fires again on something they
already judged. Keying on subject means the finding is stable and the **count grows inside it**.

```ts
type Finding = {
  id: string;                    // findingId — this session's instance
  subjectId: string;             // cross-session identity: score, dismissals, audit
  dimension: string;
  subject: string;               // human-readable: "use pnpm, never npm"
  evidence: TurnRef[];           // grows over time; never part of the identity
  occurrences: number;
  confidence: 'certain' | 'high' | 'medium' | 'low';
  method: 'RULE' | 'RULE+T' | 'LEX' | 'EMB' | 'CLS' | 'JUDGE' | 'STAT';
  backend?: string;              // null for rules
  modelVersion?: string;
  requiresOutcome: boolean;
  outcome?: 'converged' | 'reverted' | 'abandoned' | 'unknown';
  polarity: 'lower-is-better' | 'higher-is-better' | 'neutral';  // which way is good
  suppressedBy?: { kind: 'guard'; since: string };               // ≠ improved
  artifacts: ('prompt' | 'guard' | 'rule')[];   // may be empty — report-only
  firstSeen: string; lastSeen: string;
  surfaced: boolean;             // ambient dedup
  dismissed?: { at: string; reason?: string };
};
```

### 3. The skeleton — a versioned format with three consumers

The skeleton is the single most over-loaded artifact in the design. It is simultaneously:

1. **model input** (~2K tokens so a window fits a 4K prompt with rubric and examples),
2. **the evidence shown to the user** (`explain` prints it),
3. **the future team product's wire format** (fully redacted, transmissible).

One canonical typed structure, two renderings:

```ts
type Skeleton = {
  v: 1;                          // format version — see below
  sessionId: string;
  window: { from: TurnRef; to: TurnRef };
  lines: SkeletonLine[];
};

type SkeletonLine =
  | { k: 'user';   ref: TurnRef; text: string }            // redacted, truncated
  | { k: 'assist'; ref: TurnRef; text?: string }           // usually elided
  | { k: 'tool';   ref: TurnRef; tool: string; target?: string; lines?: number }
  | { k: 'result'; ref: TurnRef; ok: boolean; failures?: number; err?: string }
  | { k: 'meta';   ref: TurnRef; kind: 'compaction' | 'interrupt' | 'commit' | 'revert' };
```

rendered to text for models and humans alike:

```
U  fix the login bug
→  Read auth.ts
→  Edit auth.ts (60 lines)
✗  Test FAIL (3) "token undefined"
→  Edit auth.ts (55 lines, ~80% similar)
✗  Test FAIL (3) same error
U  it's still broken                      [correction]
```

**Three constraints baked in from the start, because retrofitting any of them is expensive:**

- **Redacted at construction, never after.** No file contents, no absolute paths, no identifiers, no
  secrets. Built as if it will be transmitted, even though in v1 it never leaves the machine — that is
  what makes a team product possible later without re-architecting, and what prevents the first sync
  feature from leaking something.
- **`v` is in the cache key.** The verdict cache key becomes
  `hash(skeleton.v + skeleton content + detector version + model name + model version)`. This is what
  lets the text rendering evolve freely: bump `v`, old verdicts miss rather than silently describing a
  format that no longer exists.
- **Budgeted, with elision recorded.** When a window exceeds the token target, lines are dropped by
  rule (assistant prose first, then tool detail) and the elision is noted in the output rather than
  hidden — a skeleton that silently drops the decisive turn would produce a confident wrong verdict.

### Storage: nothing raw is ever kept

| What | Where | Why it is safe to keep |
|---|---|---|
| **Catalog** — offsets, hashes, versions, source paths | `$XDG_DATA_HOME/vibesenpai` | bookkeeping only, no content. 4 KB where copying was 10.4 MB |
| **Findings** — redacted, no file contents | same store, SQLite | the running score needs the history |
| **Skeletons for windows that produced a finding** | same store | redacted **at construction** — no file contents, no absolute paths, no identifiers. ~10% of raw size |
| **Raw transcripts** | **never stored** | a transcript can contain a leaked token; duplicating it would make the breach ours |
| **Models** (~270 MB) | `$CLAUDE_PLUGIN_DATA` | large, disposable, removed on plugin uninstall |

**Persisting skeletons rather than copies is what makes keeping no transcripts safe rather than merely
cheaper.** `explain` prints a skeleton anyway, so evidence survives the harness deleting a source
*in the form the user actually sees* — at a tenth the size, with nothing secret in it. The redaction
designed for the future team wire format (D27) pays for itself twice.

The split follows from what losing each would cost: the catalog and findings are irreplaceable once a
source ages out; models are a re-download. Hence the store survives plugin uninstall and the models
directory does not.

### SQLite: minimal now, migrations from the first write

```sql
meta(key, value)                       -- schema_version, created_at
sessions(session_id PK, harness, project, started_at, ended_at,
         source_path, byte_offset, mtime, harness_version, gone, outcome,
         turn_count, edit_count, tool_call_count,          -- rate denominators:
         verified_edit_count, success_claim_count)         -- every delta is a SQL aggregate
findings(id PK, subject_id, session_id, dimension, subject, occurrences, confidence,
         method, backend, model_version, outcome, artifacts_json,
         first_seen, last_seen, surfaced, dismissed_at, dismissed_reason)
evidence(finding_id, uuid, session_id)                  -- the TurnRefs
verdicts(cache_key PK, dimension, verdict_json, backend, model_version, created_at)
dismissals(subject_id PK, at, reason)                   -- cross-session, so it stays dismissed
constraints(subject_id PK, project, text, source, first_stated_at, violations)
                                                        -- powers the CLAUDE.md audit
```

**Events are deliberately not stored.** They are re-derived from the source on demand, because the
catalog is already incremental (offset + mtime per file), re-parsing only changed bytes is cheap, and
storing every event would balloon the database for data we already hold verbatim. `agentsview`
indexes events for search speed — but search is not our product, so the trade goes the other way.
Revisit only if measurement shows re-parsing is the bottleneck.

`constraints` is the non-obvious table: the `CLAUDE.md` audit needs *violation history per rule over
time*, which cannot be reconstructed from findings alone once sessions age out.

**Migrations exist from the first write** — a `meta.schema_version` row and an
ordered list of forward migrations, applied in a transaction. Not because the first schema is likely
right, but because it is likely wrong.

### What is explicitly deferred

Catalog file naming; detector internals beyond the async signature; CLI and
dashboard rendering; indices (added when a measurement shows a slow query); the `Backend`
implementations beyond the null one; and the eval harness's storage. None of these are read back by a
*later* version of the code in a way that breaks, so they can be designed while being built.
---

---

*Extracted from the planning document (2026-10-12/15). Reasoning is kept with each
conclusion deliberately — see [DECISIONS.md](../DECISIONS.md) for the index.*
