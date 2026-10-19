# agentsensei

## Value proposition

> **`agentsensei` finds the turns where you and your agent wasted effort, shows you the evidence, and
> — where one exists — gives you something you can actually apply.**

**Two outputs. Never a third.**

1. **Evidence** — the exact turns where it went wrong, verbatim. Not a score, not a percentage.
2. **Something applicable** — a **prompt**, a **guard**, or a **rule** diff. Named directly; there is
   deliberately no umbrella term for the three (see below).

**What it never does: give behavioural advice.** No "be more specific." No "you should verify more
often." The distinction that defines the product:

> **Advice is addressed to you. What we generate is addressed to your agent.**
> Advice needs you to change a habit. A generated prompt or guard needs one keystroke.

The posture is advisory — nothing is ever auto-applied, you choose, and consent is required before
anything is written. The *deliverable* is concrete.

### There is no umbrella term, on purpose

An earlier draft called these "handoffs." That needed a paragraph to explain, which is proof it was
wrong. "Fix" was the next candidate, and it fails for a more interesting reason: **we cannot deliver
one for every finding, and the catalogue says so plainly.**

| | Count |
|---|---|
| Dimensions with something applicable (guard / prompt / rule) | **10** |
| Report-only — nothing to apply, only a stated cost | **6** |
| Strengths — no fix by definition; they are good things | **5** |

The unmapped remainder skews report-only, because the aggregate dimensions (`context_saturation`,
`context_hygiene`) are statistical properties and no artifact patches a correlation. So **roughly half
the problem dimensions get something applicable and half get an honest "here is the cost."** A
collective noun promising a fix would be a promise broken half the time.

So: **`fix` survives as the command verb only** — it names *the user's intent*, not our guarantee.
`agentsensei fix 3` means "fix this for me", and a legitimate answer is "no fix exists for this one."
The output names the kinds directly, and the honest case is a first-class answer rather than an
awkward empty list:

```
  "use pnpm, never npm" · violated 7×
  evidence: turns 31, 44, 58, 72

  → prompt   hand the cleanup to your agent
  → guard    deny npm outright
  → rule     CLAUDE.md diff
```

```
  context_saturation · your correction rate triples past 70% context
  evidence: 14 of 19 corrections occurred above 70%

  no fix available — this is attention dilution, not something you're doing wrong.
  the available move is to compact earlier or split long sessions.
```

### The three kinds

One finding — *"use pnpm, never npm" violated 7×* — can produce three. The user picks one, or none:

| Kind | What it is | What it does |
|---|---|---|
| **Prompt** | text loaded with the evidence, dropped into the session by `/sensei:fix` | the agent cleans up the damage that already happened |
| **Hook** | a `PreToolUse` / `Stop` config snippet, printed for consent | makes the mistake impossible, or catches it the moment it happens |
| **`CLAUDE.md` diff** | specific lines to add — and more often, per the research, to **remove** | adjusts the standing rules, budget-checked |

```
In this repo I've told you to use pnpm instead of npm. You used npm anyway here:

  turn 31  Bash: npm install lodash
  turn 44  Bash: npm run build
  turn 58  Bash: npm install --save-dev vitest

Please: (1) check whether package-lock.json was created and remove it if so,
(2) verify pnpm-lock.yaml is intact, (3) re-run the equivalent pnpm commands.
```

Note what that is not: it is not "you should be more consistent about pnpm." It is a specific cleanup
task addressed to the agent, with the receipts attached.

### Why this framing and not "coaching"

Three reasons it is strictly better than giving advice, and they are the reasons to build it this way:

1. **It sidesteps the credibility problem.** We never claim to know how to fix your code. We claim to
   know *where it went wrong* — the thing we can actually prove from the transcript.
2. **We only have to be right about the evidence, not about the fix.** A large reduction in what the
   product must get right to be trustworthy.
3. **Findings have somewhere to go.** A pure analyzer is a one-time curiosity: it tells you "7 rework
   loops this week", you think *huh*, and the second run repeats what you already know. **No exit
   means no second run.** Where we can generate something applicable, that is what makes this a tool
   rather than a party trick — and where we cannot, the stated cost at least has to be specific
   enough to act on yourself.

It also beats prose on the evidence already gathered: a prose rule *hopes* for the model's attention
and closes ~3.6% of the compliance gap; a hook applies mechanically and closes ~10.2%; a prepared
prompt is a concrete task an agent executes rather than a rule it may ignore.

### Order: problems first, then strengths

Problems lead. Someone running this wants to know what is costing them, and burying that under praise
reads as evasive. **Strengths come second, not last, and with the same evidentiary standard — and they are **earned and comparative**, never flattery, because we have a real
population baseline: **17,968 real sessions, 69% Claude Code.**

So a strength claim looks like *"you name the specific error in 78% of your corrections; the corpus
median is far lower"* or *"your loops converge 8 times in 9"* — a measured statement against a
published baseline, not a pat on the head. Behaviour-change reviews list positive reinforcement among
the best-supported techniques, so this is mechanism rather than decoration.

There is also a protective reason. If someone's strength is *always runs the tests*, then advice to
move faster would destroy it. A tool that cannot see strengths cannot avoid damaging them.

### Positioning: what we are not

- **Not a cost tracker.** `ccusage` owns spend with ~19k stars and a two-second cold start. We measure
  *wasted turns*, not tokens — and the design doc's third principle is explicitly skill, not volume.
  The headline must not borrow spend's vocabulary.
- **Not a search tool.** `agentsview` owns that with ~6k stars.
- **Not a guardrail.** Tools that block destructive commands exist and are a different product. We
  report exposure; we never block.
- **Not a coach that lectures.** The one tool that tried advice-led coaching has 339 stars and has
  been stale for six months.

**The pattern worth learning from those numbers** is not "nobody wants analysis." The tools with
traction all *answer a question the user already had* — "how much did I spend?", "where was that
session?" — and answer it in seconds. Anything that tells the user something they did not ask about
has to earn the right first. So the first run must be useful with **zero accumulated history**, which
is a hard design constraint, not a marketing preference.

### One retraction

An earlier draft oversold the measured before/after "proves improvement" loop as a headline
differentiator. It is the **weakest** one: it takes weeks to pay off, it asks the user to believe
something before it can demonstrate anything, and most users will not stay that long. Worth building
later. Wrong thing to build the identity on. **What you can apply is the identity.**
---

## Quickstart — the harness is the product

**Users live in the harness. The CLI is the secondary surface.** An earlier draft of this document had
`npx agentsensei` as step one and the plugin as step four, which was backwards.

The plugin **bundles the analyzer** — hooks and commands invoke the bundled JS directly, so nothing
needs installing from npm to use the product. The npm package exists for CI, scripting, and people who
want it outside a session.

### 1. Install, from inside Claude Code

```
/plugin marketplace add crozzfire/agentsensei
/plugin install agentsensei
```

That is the whole install. **Claude Code writes its own config** — registering `/agentsensei:*`
commands and the `SessionStart` / `Stop` / `PreCompact` / `SessionEnd` hooks from the plugin's
`hooks.json`. `agentsensei` writes nothing, which is why this path is preferred over any installer of
ours: the never-touch-your-config rule is satisfied structurally.

The manifest's `userConfig` (verified as a real plugin.json field, used by mem0) prompts at install
for the handful of settings worth asking up front — store location override, and whether the ambient
statusline is wanted at all. Nothing sensitive, nothing required.

### 2. First session after install — the onboarding moment

This is the answer to *"where is the hook for setup?"* The `SessionStart` hook detects a first run
with no catalog and emits a one-time brief. Hook stdout lands in the agent's context, so Claude
relays it — the same mechanism mem0's plugin uses:

```
  agentsensei installed · 34 sessions found in ~/.claude/projects, not yet analysed

  /agentsensei:setup   analyse them and show your first report  (~10s, no download)
  /agentsensei:now     analyse just this session
```

Shown **once**, then never again. Discovery happens where the user already is, with no README
required and no CLI invocation.

### 3. `/agentsensei:setup` — onboarding, in the harness

```
  Scanned 34 sessions over 18 days · copied nothing (catalog: 31 KB)

  COSTING YOU
  ✗ edit_retry              9 edits refused, then retried       /agentsensei:fix 1
                            7× read the file before editing it
                            2× the anchor matched several places
  ✗ file_churn              src/api.ts went through 12 versions /agentsensei:fix 2

  DOING WELL
  ✓ convergent_iteration    11 of 13 loops resolved

  THIS SESSION COST
    412k in · 38k out · 3 compactions · 2.1M re-ingested

  No trend yet — deltas appear from your next run onward.

  CLAUDE.md · 740 words, over the ~500-word ceiling
    6 rules never violated in 34 sessions · 1 violated weekly       /agentsensei:claude-md

  ── optional ─────────────────────────────────────────────────────

  Statusline · you have none configured. A one-line nudge after chunks of work.
  This needs a settings.json write — shown before writing.          [add it?]

  Semantic analysis · not installed. /agentsensei:setup-models      (270 MB)
```

The statusline is asked **here and nowhere else**, because it is the one thing requiring a
`settings.json` write and this is the moment the user has just seen what the tool does. Semantic analysis was already offered at install, so `setup` only reminds anyone who deferred — it
never re-asks.

**Statusline is the one thing the plugin cannot do for itself** — verified: no official plugin ships
one, because it is a `settings.json` field rather than a plugin capability. So it requires a consented
write, and `/agentsensei:setup` is where that consent is asked.

### 4. Daily use — entirely in the harness

```
/agentsensei:now           what happened in this session
/agentsensei:fix 2         evidence + what you can apply
/agentsensei:report 7d     the week
/agentsensei:claude-md     which of your rules are dead weight
/agentsensei:why 2         the exact turns, verbatim
/agentsensei:setup-models  the semantic-analysis download, if deferred at install
```

Plus the ambient surface, which needs no command at all:

```
[session start]
  agentsensei · last 7d: 14 sessions · 72% of edits verified · 3 loops unresolved
  Run /agentsensei:now to view more details.

[later, after a commit lands]
  ⌁ 3 edits refused then retried · +1 more   ← statusline only. never interrupts.
```

### `fix` in the harness, which is where it gets good

```
/agentsensei:fix 2

  constraint_decay · "use pnpm, never npm" · violated 7×
  stated: ode/ session 4c1f, turn 3       method: RULE + NLI (contradiction 0.94)

  EVIDENCE
    turn 31   Bash: npm install lodash
    turn 44   Bash: npm run build
    turn 58   Bash: npm install --save-dev vitest       … 4 more

  WHAT YOU CAN DO
    prompt   I'll clean this up now                 → /agentsensei:fix 2 --prompt
    guard    deny npm before it runs                → /agentsensei:fix 2 --guard
    rule     add a line to CLAUDE.md                → /agentsensei:fix 2 --rule
             ⚠ your CLAUDE.md is over budget, and prose closes ~3.6% of the
               compliance gap vs ~10.2% for a guard
```

`--prompt` in-harness does not print text to copy — **it hands the task straight to the agent in the
session you are already in**, which is the whole argument for the harness being primary. The CLI
version can only put it on your clipboard.

### Secondary: the CLI

For CI, scripting, trying it before installing a plugin, or working outside a session. Same code, same
findings:

```
npx agentsensei                 see where you stand (rules only, no download)
agentsensei fix 2 --guard       prints the hook JSON for consent
agentsensei init                the non-plugin path: offers hooks + statusline, asks for each
agentsensei models install      explicit download (same as :setup-models)
agentsensei doctor              harnesses, models, paths, retention warning
```

`agentsensei init` exists only for people who did not install the plugin — it does by hand what
`/plugin install` does natively, and is therefore the worse path.

### The empty state, which still has to be good

```
$ npx agentsensei

  scanning ~/.claude/projects … no sessions found

  Claude Code deletes transcripts after 30 days by default (cleanupPeriodDays),
  and nothing remains on this machine. There is nothing to analyse yet.

  agentsensei reads your transcripts in place and never copies them, so it
  cannot recover sessions the harness has already removed.

  → install the plugin and it will track sessions as you work:
      /plugin marketplace add crozzfire/agentsensei
```

Never a bare zero, never a stack trace — and it routes to the primary surface rather than to itself.

---

---

*Extracted from the planning document (2026-10-12/15). Reasoning is kept with each
conclusion deliberately — see [DECISIONS.md](DECISIONS.md) for the index.*
