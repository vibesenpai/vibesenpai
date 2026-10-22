# From finding to something applicable

> **Note (2026-10-19):** examples below may name dimensions that were deleted in the reset —
> `tool_loop`, `revert_churn`, `inaccurate_self_report`, `no_verification`. The mechanics they
> illustrate still hold; the dimension names do not. See [dimensions.md](dimensions.md) for what is
> actually detected and `GRAVEYARD.md` for why.


## From finding to something applicable

Everything above *detects*. This section specifies the other half: how a finding becomes something you
can use. Per the value proposition, these are **artifacts, never advice** — and the research below
immediately killed the artifact this document originally made flagship.

**Terminology note:** an earlier draft called this "the coaching layer" and framed interventions as
behaviour change. That framing is retired. The tiers below are *artifact kinds ranked by measured
effectiveness*, not a curriculum. The user is never told to be better at anything.

### The finding that breaks the obvious plan

My assumed fix for `constraint_decay` and `repeated_instruction` was "draft a `CLAUDE.md` line." A
study of **753 rules across 410 repositories** — measured by AST analysis at rule-introduction and at
HEAD, with **no LLM scoring, so every figure is reproducible** — says that barely works:

| Rule type | Pre-rule compliance | Change after adding the rule |
|---|---|---|
| Line length | 97.1% | **−0.05 pts** (nothing) |
| Type annotations | 83.6% | +1.45 pts |
| Docstrings | 69.2% | +1.63 pts |
| **All rules, overall** | — | **+0.066 pts** |

Worse: **66.7% of rules describe code that already complied** — they are ceremonial, not
prescriptive. And of the 251 rules that genuinely asked for change:

- **Tool-backed enforcement closed 10.21% of the remaining gap**
- **Prose-only declarations closed 3.64%** — roughly **one third as effective**, at `p = 0.022`

The explanation is mechanical and convincing: *a formatter or type checker applies the rule to
whatever passes through it, while an agent editing a file for an unrelated reason usually leaves a
prose rule unapplied.*

Compounding this, a separate paper on **"catastrophic remembering"** documents `CLAUDE.md` growing
unbounded and *degrading* performance — token cost, noise, slower retrieval — with pruning and token
budgeting as the remedies. Practical ceilings reported elsewhere: models follow ~150–200 instructions
before adherence degrades (with ~50 already spent on system instructions), well-performing files
average **300–350 words**, past 500 shows diminishing returns, and past 1,000 the correlation with
performance goes **negative**.

**Conclusion: "add a line to CLAUDE.md" is a weak intervention that gets weaker every time you use
it.** Any coach that treats it as the default answer is making its user worse over time. That single
finding restructures this entire section.

### Artifact kinds, ranked by measured effectiveness

```
  1. GUARD      a hook. mechanical, cannot be ignored            ~10.2% of gap closed, p=0.022
  2. PROMPT     evidence-loaded text, handed to the agent        the default artifact
  3. MEMORY     a CLAUDE.md diff — often a removal                ~3.6% of gap, budget-limited
  4. REPORT     stated cost, no artifact available               honest, not a cop-out
```

**`PROMPT` replaces what an earlier draft called `PRACTICE`.** That tier told the user to prompt
better — which is advice, and therefore out of scope now. The same finding instead produces a prompt
addressed to the *agent*: here are the turns where my instruction was missed, clean it up. The
evidence that a prepared task beats a prose rule is the same tool-backed-vs-prose result, and it
carries over: an agent executes a task; it may ignore a rule.

`WORKFLOW` and `ACCEPT` collapse into **`REPORT`** for the same reason. "Compact earlier" is advice.
What we can honestly ship is the measured cost — *"your correction rate triples past 70% context"* —
and let the user decide. No artifact exists for some findings, and saying so plainly is better than
manufacturing a tip.

**`GUARD` is the headline, and it resolves your "maybe some aren't solvable" point.** You cannot make a
model honest — but you can make its dishonesty fail to land.

**Nothing a guard does ever blocks the user.** The user is never interrupted, their prompts are never
rewritten, and nothing they type is ever withheld. Guards act on the *agent's* actions and claims.
Three hook points, with genuinely different powers — and the distinction matters, because it decides
which dimensions can actually be guarded:

| Hook | When it fires | Power | Guards what |
|---|---|---|---|
| **`PreToolUse`** | before a tool runs | **can deny the call** — true prevention | *action*-shaped failures: a command, a write, a push |
| **`Stop`** | when the agent finishes its turn (**not** the user — the name is about the agent stopping) | cannot block anything; its stdout goes into the agent's context | *claim*-shaped failures: detect-and-feed-back, agent self-corrects next turn |
| **`UserPromptSubmit`** | when the user submits | *could* block or rewrite the prompt | **never used for this. Ruled out permanently.** |

**I overstated the `inaccurate_self_report` case and should correct it:** that one is *caught*, not
prevented. By the time `Stop` fires, the agent has already said "all tests pass." The hook cannot
retract it. What it can do is put the contradiction into the agent's context — *"the last test run
reported 2 failures; your claim conflicts with it"* — so the agent corrects itself on the next turn
instead of the user discovering it an hour later. That is a tight feedback loop, and genuinely
valuable, but it is not prevention and should not be sold as such.

**True prevention only works on action-shaped failures**, via `PreToolUse`:

```jsonc
// generated by: agentsensei fix --guard pnpm      (printed for consent, never auto-written)
{ "PreToolUse": [{ "matcher": "Bash",
    "hooks": [{ "type": "command",
      "command": "agentsensei guard pnpm",     // exits non-zero → the npm call is denied
      "timeout": 2 }] }] }
```

That genuinely stops `npm install` from ever running in a repo where the user said pnpm. The agent
gets told why and retries correctly. No prose rule, no reliance on attention, no user involvement —
which is precisely the mechanism behind tool-backed enforcement closing ~3× the gap that prose does.

So the honest split: **`PreToolUse` guards prevent** (`constraint_decay` on commands,
`premature_external_write`, `irreversible_action`); **`Stop` guards catch and correct**
(`inaccurate_self_report`, `no_verification`). Both beat prose; only the first is a guarantee.

This is also why the plugin architecture matters more than it first appeared: `agentsensei` already
ships hook infrastructure, so it can *generate* guards as its primary output rather than suggesting
prose and hoping.

**One measurement consequence, and it is easy to get wrong.** A guard deliberately injects into the
agent's context — the exact thing ruled out for ambient reporting, because it perturbs the session
being measured. For a guard that is the *point*: it is an intervention, not an observation. But it
means **a guarded dimension's count dropping to zero is not evidence the user improved** — the guard
is suppressing it by construction. So the trend view must label guarded dimensions as *suppressed*,
and keep measuring the unguarded ones as the real behaviour signal. Conflating "the guard works" with
"the habit changed" would be the tool telling itself a flattering story.

**`PROMPT` has measured support, and from a useful direction.** **AutoPrompter** improved edit
correctness **+27%** by *automatically inferring the context missing from a developer's prompt* —
which is a machine filling the gap, not a human being taught to. That is precisely our model:
the artifact supplies what the prompt lacked instead of telling the user to write better prompts.
(**Prompt Coach** separately improved prompt scores **+13.7%** after a 60-minute teaching session,
with the biggest gains on the lowest-scoring dimensions — real, but it is the advice-led path we are
not taking.)

The useful inheritance from both: the gap is usually **constraints, error handling, and context
awareness**, and those are exactly the things a generated prompt can carry on the user's behalf. So
the generator populates them from the transcript rather than asking the user to remember them.

### `MEMORY` becomes a budget, and that unlocks a feature nobody has

Since prose rules are weak and bloat is harmful, `CLAUDE.md` is treated as a **scarce resource under
a word budget**, not an append-only log. `agentsensei claude-md` audits it:

```
$ agentsensei claude-md

  CLAUDE.md · 740 words · over the 500-word effective ceiling

  CEREMONIAL — never violated in 43 sessions, spending budget for nothing
    "prefer const over let"              0 violations    → remove
    "use 2-space indentation"            0 violations    → remove (your formatter does this)

  INEFFECTIVE — present, still violated. Prose isn't working here.
    "always use pnpm, never npm"         7 violations    → convert to a GUARD
                                                            agentsensei fix --guard pnpm

  WORKING — keep
    "never edit files in dist/"          2 violations, both self-corrected
```

**We can do this and competitors cannot, because we have the before/after violation data.** The study
found two-thirds of rules are ceremonial but could only say so in aggregate; with a session catalog we
can say it *per rule, for one person's actual repo.* This is the single most novel coaching feature in
the plan, and it falls directly out of the research.

Note the asymmetry it creates: the most valuable `MEMORY` action is often **removal**, not addition.
A coach that only adds is the mechanism of catastrophic remembering.

### The loop that makes it coaching rather than advice

Behaviour-change research is consistent about which techniques work: **self-monitoring, goal setting,
cues, and positive reinforcement** are the most-applied and best-supported across systematic reviews,
and deliberate practice requires *monitoring your own performance and getting feedback on it.* The
plan already had self-monitoring and cues. It was missing goal setting and, crucially, the measured
feedback that closes the loop.

```
   detect  →  recommend exactly ONE thing  →  user applies it  →  measure the SAME
   dimension over the next N sessions  →  report the delta  →  keep, or revert and try again
```

This is an A/B test the user runs on themselves, and **it is the sixth differentiator
("proves improvement") made concrete.** Nothing in the competitive landscape does it: vibe-log gives
advice and never checks whether the advice worked; `session-report` has the model write narrative
suggestions with no follow-up at all.

Three rules keep it honest:

1. **One recommendation at a time.** 40 dimensions cannot all be worked on, and goal-setting research
   is clear that a single specific goal beats a list. `agentsensei fix` returns exactly one thing —
   the highest-yield item for *this* user, which is usually their weakest dimension rather than the
   most frequent finding.
2. **State the baseline before the intervention, and the delta after.** "Unverified acceptances: 9
   last fortnight → 3 this fortnight" is a claim with evidence. "You're improving!" is not.
3. **Admit when it did not work.** If the dimension does not move after N sessions, say so and
   propose escalating the intervention tier — prose → guard — rather than quietly repeating the
   advice. A coach that never reports a failed intervention is not measuring anything.

Positive reinforcement comes from group F: the healthy dimensions are the reward signal, which is why
they are credited rather than merely withheld.

### `ACCEPT` — the honest category

Some things genuinely are not fixable by the user, and saying so is more useful than inventing advice.
`context_saturation` is close to physics: attention dilutes as the window fills, and no prompt fixes
that — the only moves are workflow ones (compact earlier, split the session). `goal_drift` is a
model-attention property; restating the goal mitigates it but nothing eliminates it.

For these, the report states the cost and the mitigation, and explicitly says there is no fix:
*"Your correction rate triples past 70% context. This is a known attention-dilution effect, not
something you're doing wrong. The available move is to compact earlier or split long sessions."*

That is more respectful of the user than manufacturing a tip, and it is the only intellectually honest
option for a tool whose first principle is evidence.

### Artifact mapping — every dimension's exit

| Dimension | Kind | The artifact | Effect |
|---|---|---|---|
| `constraint_decay` (command-shaped) | **GUARD** | `PreToolUse` on the specific command (`npm` → `pnpm`) | **prevents** — call denied |
| `premature_external_write` | **GUARD** | `PreToolUse` on push/publish with no passing verification | **prevents** |
| `inaccurate_self_report` | **GUARD** | `Stop`: feed the contradiction back; agent self-corrects next turn | catches |
| `no_verification` | **GUARD** | `Stop`: flag source edits closed with nothing run | catches |
| `irreversible_action` | *report only* | surface the Tier-1 list; point at existing guardrail tools — blocking is not our product | neither |
| `prompt_specificity` / `_verification` / `_context` | **REPORT** | the measured distribution + their own strongest examples | states cost |
| `vague_correction` | **REPORT** | side-by-side with their own `effective_correction` examples | states cost |
| `unverified_acceptance` | **REPORT** | stated as "no check visible in session" — the blind spot is real | states cost |
| `context_saturation` | **REPORT** | the threshold computed from *their* data | no fix exists |
| `context_rationale_erosion` | **MEMORY** | a `CLAUDE.md` diff — the one place compaction cannot reach | prevents |
| `context_hygiene` | **REPORT** | reported as a positive habit score | strength |
| `repeated_instruction` | **MEMORY** → **GUARD** | a diff first; escalate to a guard if still violated | prevents on escalation |
| `constraint_decay` (prose-shaped) | **MEMORY** | budget-checked, and only if the budget allows | weak (~3.6%) |
| `goal_drift` | **PROMPT** | a prompt restating the original goal, with the drift evidence | agent re-aligns |
| `rework_loop`, `fail_fix_fail` | **PROMPT** | a prompt naming the repeated failure + what was already tried | agent breaks the loop |

### What this adds to the milestones

**Generated prompts are the product, so they move earlier than a "coaching" feature would have.**

- **M2** gains **`PROMPT` generation** alongside the detectors. This is the default artifact and the
  thing that gives every finding an exit, so it ships *with* the first detector rather than after all
  of them. Cheap: a template per dimension, filled with the evidence the detector already produced.
  The artifact-kind mapping is static, so routing a finding to its kind is a lookup.
- **M3** gains the `CLAUDE.md` violation history that the audit needs, plus `MEMORY` diff generation.
  Baseline/delta tracking also lands here — but as a *later* payoff, not a headline (see the
  retraction in the value proposition).
- **M6** gains **`GUARD` generation** — the most effective artifact kind, and the clearest
  justification for shipping a plugin rather than only a CLI.
- **New commands:** `agentsensei claude-md` (audit: ceremonial / ineffective / working) and
  `agentsensei fix [--prompt | --guard | --claude-md]`.
- **`agentsensei fix` is the product's point, not a convenience.** It returns the finding, its
  evidence, and the available artifacts. For `--prompt` it prints text ready to paste or to drop in
  via `/agentsensei:fix`. For `--guard` it prints the exact hook JSON **for consent, never silently
  written.** For `--claude-md` it prints a diff, budget-checked. If no artifact exists it says so and
  states the cost instead of inventing a tip.

### So: rename, or keep?

**Keep `agentsensei`.** The gap was a specification gap, not a naming one — and it is now
closed with a research spine under it: a ranked intervention hierarchy with measured effect sizes, a
generated-guard mechanism for the failures users cannot fix, a `CLAUDE.md` audit no competitor can
build, and a measured keep-or-revert loop.

Renaming to "analyzer" would have locked in the lesser product permanently. The honest position is
that the name was *aspirational* before this document and is *specified* after it — and that `GUARD` generation is
what earns it, because it is the one tier that changes outcomes without requiring the user to change
anything at all.

---

*Extracted from the planning document (2026-10-12/15). Reasoning is kept with each
conclusion deliberately — see [DECISIONS.md](../DECISIONS.md) for the index.*
