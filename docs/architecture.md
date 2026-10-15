# Architecture

How the pieces fit, what each owns, and the invariants that must not be broken. Decisions and their
evidence live in [DECISIONS.md](../DECISIONS.md); this document is the mechanical view.

**Status legend:** ✅ implemented · 🔨 next · 📋 planned

---

## 1. The pipeline

```mermaid
flowchart LR
  subgraph live["Harness, live"]
    CC["~/.claude/projects<br/>*.jsonl"]
  end

  subgraph store["agentsensei store"]
    AR["archive/sessions<br/>raw, append-only, 0700"]
    IX["index.json<br/>offset + mtime + sha256"]
    DB[("SQLite<br/>findings, verdicts,<br/>constraints")]
  end

  subgraph pipe["Analysis"]
    PA["parser<br/>tree to leaf path"]
    EV["Event stream"]
    RD["redactor"]
    SK["skeletonizer<br/>windows, ~2K tokens"]
    DT["detectors"]
    OC["outcome<br/>classifier"]
  end

  subgraph out["Surfaces"]
    ST["statusline<br/>ambient nudge"]
    SL["/agentsensei:*<br/>slash commands"]
    CL["CLI"]
    AF["artifacts<br/>prompt / guard / rule"]
  end

  CC -->|"incremental copy"| AR
  AR --- IX
  AR --> PA --> EV --> RD --> SK --> DT
  OC --> DT
  EV --> OC
  DT -->|"findings"| DB
  DB --> ST
  DB --> SL
  DB --> CL
  DB --> AF

  classDef done fill:#1a4d2e,stroke:#2d8659,color:#fff
  classDef next fill:#4d3a1a,stroke:#997a2d,color:#fff
  class CC,AR,IX done
  class PA,EV next
```

**The one-way rule:** everything downstream reads the **archive**, never the live directory. The only
exception is `agentsensei now`, which tails the in-flight transcript because the current session is
still being appended to — the same incremental reader with a different source.

**Why the archiver comes first.** The harness deletes transcripts after 30 days by default
(`cleanupPeriodDays`). On the machine this was designed on, that had already removed 39 of 41
sessions. Preservation is not a feature of the analyzer; it is a precondition for having anything to
analyse.

---

## 2. A transcript is a tree, not a log

The single most consequential parser fact. Every record carries `parentUuid`; rewind and compaction
create branches that are no longer live.

```mermaid
flowchart TD
  R["u1 · user: fix the login bug"] --> A["u2 · Read auth.ts"]
  A --> B["u3 · Edit auth.ts"]
  B --> C["u4 · Test FAIL"]
  C --> D["u5 · Edit auth.ts"]
  C --> E["u6 · Edit auth.ts<br/>after rewind"]
  E --> F["u7 · Test PASS"]

  D:::dead
  classDef dead fill:#3d1a1a,stroke:#8b3a3a,color:#999,stroke-dasharray: 4 3
  classDef live fill:#1a4d2e,stroke:#2d8659,color:#fff
  class R,A,B,C,E,F live
```

`u5` is on an **abandoned branch**. Reading the file in line order would count both `u5` and `u6` as
edits, so a rework detector would see four edits where the user made three — inflating every
loop-shaped dimension with work that was discarded.

**Therefore:** reconstruct the active leaf path first, then index. `seq` is a position on *that path*
and is recomputed on every read. Evidence is stored by `uuid`, never by `seq` — see
[contracts.md](contracts.md).

**Sidechains** are the sibling problem: subagent events are interleaved into the same file
(`isSidechain`). A parallel fan-out legitimately reads the same files many times, so sidechain events
are attributed to their subagent and excluded from main-thread windows, or `reading_spiral` fires on
every healthy fan-out.

---

## 3. Hook lifecycle and the producer/consumer queue

Analysis never runs inside a hook. A hook's job is to move bytes and exit.

```mermaid
sequenceDiagram
  participant U as User
  participant H as Harness
  participant K as Hooks
  participant W as Detached worker
  participant S as Store
  participant L as Statusline

  Note over K: every hook: timeout set, exits 0 unconditionally

  H->>K: SessionStart
  K->>S: read pre-computed aggregate
  K-->>H: stats only, no instructions
  H-->>U: "last 7d: 14 sessions, 72% verified ↑5%"

  U->>H: prompt
  H-->>U: response
  H->>K: Stop
  K->>S: drain ready findings
  K->>L: update nudge
  K->>S: append new transcript bytes
  K->>W: spawn if a window closed
  K-->>H: exit 0, under 10ms
  W->>S: write findings as each window completes

  H->>K: PreCompact
  K->>S: capture state BEFORE context is summarised away
  Note over K,S: the only irreplaceable capture

  H->>K: SessionEnd
  K->>S: finalise, resolve provisional findings
  Note over S: nothing surfaces — nobody is watching
```

**Why the queue exists.** A `Stop` hook has a timeout budget, so blocking it to run detectors would
add latency to every single response. Instead the hook *drains* whatever the previous worker finished
and *spawns* a new one. A window analysed during turn 14 surfaces at turn 15's boundary — which is
also why batching is honest rather than a limitation: a finding is about a *window*, and the window
has to close before the finding exists.

**Why the statusline and not hook output.** Hook stdout lands in the **model's** context, not the
user's terminal — verified in a real transcript, where mem0's own `SessionStart` hook has to *ask the
model to print for it*. Injecting findings into the agent's context would also perturb the session
being measured, so the statusline is the only channel that both reaches the user and leaves the
measurement intact.

---

## 4. The detection cascade

Escalate only on ambiguity. Every tier is optional; the `core` nine need none of it.

```mermaid
flowchart TD
  E["Event window"] --> R{"rules<br/>free, under 5ms"}
  R -->|"verdict certain"| F["Finding"]
  R -->|"needs similarity"| EM{"embeddings<br/>EmbeddingGemma-300m"}
  R -->|"no signal"| N["no finding"]

  EM -->|"candidates only<br/>never decides"| NL{"NLI cross-encoder<br/>entailment / contradiction"}
  NL -->|"contradiction<br/>above threshold"| F
  NL -->|"neutral / entailment"| N

  EM -->|"needs a judgment"| CL{"SetFit head<br/>kilobytes"}
  CL --> F

  NL -->|"still ambiguous"| J{"local LLM judge<br/>batch only"}
  J --> F
  J -->|"no backend"| UN["report unknown<br/>never guess"]

  classDef free fill:#1a4d2e,stroke:#2d8659,color:#fff
  classDef paid fill:#1a3a4d,stroke:#2d6686,color:#fff
  classDef maybe fill:#4d3a1a,stroke:#997a2d,color:#fff
  class R free
  class EM,NL,CL paid
  class J maybe
```

**Embeddings shortlist; NLI decides.** Cosine similarity measures *topic*, not logical relation:
`cosine("use pnpm, never npm", "ran pnpm install")` is high, which would be a false positive. An NLI
cross-encoder answers the real question — premise vs hypothesis → entailment / neutral /
contradiction — and is correct in both directions. This is enforced in the detector interface, not
left to discipline.

The judge tier is drawn dashed on purpose: both of its dimensions are entailment questions, so it may
be deleted before it is written.

---

## 5. Outcome classification

```mermaid
stateDiagram-v2
  [*] --> analysing
  analysing --> converged: failures to zero<br/>or terminal pass<br/>or files committed
  analysing --> reverted: snapshot restore<br/>or destructive git
  analysing --> abandoned: ends failing,<br/>no commit
  analysing --> unknown: no verification signal<br/>not a git repo<br/>tests run elsewhere

  converged --> [*]: credited as strength
  reverted --> [*]: rework confirmed
  abandoned --> [*]: rework confirmed
  unknown --> [*]: SILENT
```

**The fourth state is the entire safety mechanism.** `rework_loop` fires only on `abandoned` or
`reverted` — on `unknown` it does not fire at all. Treating "could not determine" as "did not
converge" would fire on every project without tests, every uncommitted branch, and everyone who runs
tests in a second terminal. Those are **invisibility, not rework**, and conflating them is the false
flag that destroys trust.

Consequence accepted openly: on a repo with no test suite, `rework_loop` is silent, and the output
says so rather than implying a clean bill of health.

---

## 6. Onboarding

```mermaid
sequenceDiagram
  participant U as User
  participant H as Claude Code
  participant A as agentsensei
  participant HF as Hugging Face

  U->>H: /plugin marketplace add crozzfire/agentsensei
  U->>H: /plugin install agentsensei
  Note over H: the HARNESS writes its own config:<br/>commands + hooks. we write nothing.

  H->>A: SessionStart, first run
  A-->>H: "34 sessions found, not yet analysed"
  H-->>U: relayed by the model
  Note over U,H: discovery happens where the user already is

  U->>H: /agentsensei:setup
  A->>A: archive + analyse, rules only
  A-->>U: first report, no download needed
  A-->>U: offer: semantic analysis, 270 MB?

  U->>H: yes
  H->>A: foreground tool call
  A->>HF: download, lock + stamp + checksum
  Note over A,HF: never from a hook. ever.
```

**Statusline is the one thing a plugin cannot install for itself** — verified across all 26 official
plugins, none ship one, because `statusLine` is a `settings.json` field rather than a plugin
capability. So it needs a consented write, and `setup` is where that is asked.

---

## 7. Module map

```mermaid
flowchart TD
  CLI["cli.ts ✅<br/>argv, commands"] --> CFG["config.ts ✅<br/>flag → env → file → default"]
  CLI --> ARC["archive.ts ✅<br/>incremental, hashed, 0700"]
  CLI --> PAR["parsers/claude-code.ts 🔨<br/>leaf path, block flattening"]
  PAR --> TYP["types.ts ✅<br/>Event, TurnRef, Finding, Skeleton"]
  PAR --> RED["redact.ts 🔨<br/>before display, never before archive"]
  RED --> SKE["skeleton.ts 📋<br/>windows, budget, elision"]
  SKE --> DET["detectors/*.ts 📋<br/>async, declare requiresOutcome"]
  DET --> SCO["score.ts 📋<br/>rates, not counts"]
  DET --> STO["store.ts 📋<br/>SQLite, migrations"]
  SKE --> BAK["backends/*.ts 📋<br/>null today"]
  BAK --> DET

  classDef done fill:#1a4d2e,stroke:#2d8659,color:#fff
  classDef next fill:#4d3a1a,stroke:#997a2d,color:#fff
  classDef plan fill:#2a2a35,stroke:#555,color:#aaa
  class CLI,CFG,ARC,TYP done
  class PAR,RED next
  class SKE,DET,SCO,STO,BAK plan
```

| Module | Owns | Must not |
|---|---|---|
| `config.ts` ✅ | path resolution, sync-root detection | hardcode any path |
| `archive.ts` ✅ | incremental copy, offsets, hashes, 0700 | redact, parse, or write to sources |
| `types.ts` ✅ | the three pinned contracts | change shape without a version bump |
| `parsers/*` 🔨 | leaf-path reconstruction, block flattening, sidechain attribution | crash on an unknown record type |
| `redact.ts` 🔨 | secrets, paths, identifiers | run before archiving — the archive is raw by design |
| `skeleton.ts` 📋 | windowing, token budget, elision records | silently drop the decisive turn |
| `detectors/*` 📋 | one dimension each, async, declares `requiresOutcome` | emit on `EMB` alone without an NLI verdict |
| `score.ts` 📋 | rates, deltas, polarity, suppression labels | show a percentage below the minimum denominator |
| `store.ts` 📋 | SQLite, migrations, incremental writes | store raw events — they are re-derived |

---

## 8. Invariants

Enforced in code and asserted in tests, not left to discipline.

| # | Invariant | Where |
|---|---|---|
| I1 | A hook exits 0 unconditionally, always | every `scripts/` entrypoint |
| I2 | No hook ever downloads, under any config | model loader |
| I3 | Nothing is written to the user's harness config without printed, per-item consent | `init`, `fix --guard` |
| I4 | Nothing surfaces mid-response; the statusline is the only ambient channel | queue + statusline |
| I5 | The archive is raw; redaction happens at parse/display | `archive.ts` has no redactor import |
| I6 | The archive is 0700 and never inside a sync root | `initArchive` |
| I7 | Evidence is keyed by `uuid`, never by position | `TurnRef` |
| I8 | Finding identity is keyed on subject, never on evidence extent | `subjectId` |
| I9 | `unknown` suppresses a finding; it never becomes a guess | outcome classifier |
| I10 | A re-run reads zero redundant bytes | `archive.test.ts` ✅ |
| I11 | The whole pipeline runs against fixture dirs, touching no real home path | tests ✅ |
| I12 | Embedding similarity alone can never emit a finding | detector interface |

---

## 9. Current state

```
✅  config.ts        path resolution + sync-root refusal
✅  archive.ts       incremental archiver, 14 tests passing
✅  types.ts         TurnRef, Finding, Skeleton, Backend
✅  cli.ts           archive · doctor · config
🔨  parsers/claude-code.ts
🔨  redact.ts
```

Verified against real data: 3 transcripts, 5.0 MB archived; second run reads **0 bytes**.

Next is **M1** — parser, redactor, skeletonizer — then **M2a**, which is the first point the product
exists: eight outcome-free detectors, incremental persistence, and the running score.
