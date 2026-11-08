# Surfaces & principles

> **Note (2026-10-19):** examples below may name dimensions that were deleted in the reset —
> `tool_loop`, `revert_churn`, `inaccurate_self_report`, `no_verification`. The mechanics they
> illustrate still hold; the dimension names do not. See [dimensions.md](dimensions.md) for what is
> actually detected and `GRAVEYARD.md` for why.


## The product, top-down

**One sentence:** install it once, and it watches your coding sessions across every harness you use,
then tells you — pointing at specific turns — which habits are costing you time.

The thing that makes it a product rather than a script is that **you never have to remember to run
it.** A tool that requires you to type `analyze` after a bad session will only ever be run after good
ones. So observation is ambient and automatic; only *reading the results* is a deliberate act.

### Install: two paths, and the native one is better

Verified against a real multi-harness plugin on this machine
(`~/.claude/plugins/marketplaces/mem0-plugins`), which ships `.claude-plugin/`, `.codex-plugin/`,
`.cursor-plugin/`, `.kimi-plugin/` and `.opencode-plugin/` side by side from one repo.

```
# Primary — in-harness. This is the product's front door.
/plugin marketplace add vibesenpai/vibesenpai
/plugin install vibesenpai
      → Claude Code registers the commands and hooks itself. We write nothing.
      → the plugin bundles the analyzer, so npm is never involved.

# Secondary — CLI, for CI / scripting / pre-install trial
npm i -g vibesenpai && vibesenpai install
      → does by hand what /plugin install does natively; asks before each write.
      → the command is `install`, not `init`; `init` was never built.
```

**This is where your "don't change user configs" rule needs a precise edge, because installing a
plugin *is* a config write.** The distinction that matters:

- **Forbidden:** changing harness settings as a *side effect* of doing something else — e.g. `report`
  quietly raising `cleanupPeriodDays` because it would help us.
- **Fine:** changing them when that *is* the request, visibly and reversibly — `init`, with a printed
  diff, a per-harness prompt, `--print-only` to copy-paste it yourself, and `vibesenpai uninstall`
  that removes exactly what was added.

The primary path sidesteps the question entirely: the harness's own marketplace mechanism writes the
harness's own config, on the user's explicit action. That is why it is the front door, the one the
README leads with, and the reason the plugin bundles the analyzer rather than depending on a global
npm install.

**The one thing a plugin cannot do for itself is the statusline** — verified against all 26 official
plugins, none ship one, because `statusLine` is a `settings.json` field rather than a plugin
capability. So the ambient surface needs a consented write, and `/vibesenpai:setup` is where that is
asked.

### Built via settings.json, not the plugin manifest — 2026-10-19

The layout below is still the distribution plan, but **the ambient layer that
actually ships today installs into `~/.claude/settings.json`** via
`vibesenpai install`, not through `hooks/hooks.json` and `${extensionPath}`.
There is no plugin manifest yet.

Why: the goal was to see findings on a real machine, and a settings merge needs
no packaging, no marketplace, and no install step beyond a command. The plugin
route adds a build and a publish before anything can be judged.

What that costs, stated so it is not rediscovered: the commands carry
**absolute paths to this checkout**, so moving or renaming the repo breaks them
until `vibesenpai install --apply` is re-run. The plugin layout exists partly
to avoid exactly that, which is the argument for doing it before anyone else
installs this.

The merge itself is the careful part — this machine already had ten populated
hook events and its own `Stop` hook — and it lives in `src/install.ts` with the
round-trip property verified against a copy of the real file.

### What gets installed

**v1 ships Claude Code only** — one harness done properly, and the one where both your own data and
69% of the SWE-chat corpus live. But the layout is multi-harness from day one, so Codex is a later
manifest rather than a refactor:

```
vibesenpai/
  package.json                 # the npm CLI
  .claude-plugin/plugin.json   # v1 — + userConfig for store path etc.
  hooks/
    hooks.json                 # Claude Code   — ${extensionPath}
  scripts/                     # ONE set of entrypoints, harness-agnostic by design
  commands/                    # /vibesenpai:insights|why|fix|report  (+ optional bare /sensei)

  # later, verified as mostly-manifest work:
  # .codex-plugin/plugin.json  + hooks/codex-hooks.json   — ${PLUGIN_ROOT}, statusMessage
  # .cursor-plugin/plugin.json + hooks/cursor-hooks.json
```

The reason this is affordable: the hook event vocabulary is **already portable** across Claude Code,
Codex and Cursor — `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` — verified
by reading all three of mem0's hook files on this machine. The per-harness delta is the manifest and
a root-path variable name, not a reimplementation. So `scripts/` must take its paths and session id
from arguments and env, never from Claude-specific assumptions, which is a constraint on M1's
reader design rather than future work.

Copilot CLI is **unverified** — I confirmed Claude Code, Codex and Cursor from a real installed
plugin, but have not checked whether Copilot supports plugins or hooks at all. Researched when it
comes up, not assumed in the meantime.

### Which hooks, and why not more

| Hook | What we do | Cost |
|---|---|---|
| `SessionStart` | emit the pre-computed aggregate standing; note session id + cwd | microseconds — nothing is computed here, only read |
| `Stop` | drain queue → print; catalog new bytes; maybe spawn detached analysis | ~10ms, never blocks |
| `PreCompact` | **read before compaction destroys context** — the one irreplaceable capture | ~10ms |
| `SessionEnd` | finalize: resolve provisional findings, persist | nobody is watching — see below |

**`SessionEnd` surfaces nothing, because there is nobody there to surface to.** Its job is not
notification — it is *finalization*, and that is a real job: at session end the outcomes are finally
knowable, so every provisional finding resolves. The in-flight rework loop that never surfaced
either becomes a confirmed `rework_loop` (tests still failing, nothing committed) or is **discarded**
as `convergent_iteration` — and discarding it is the point. A finding that would have been a false
flag at turn 14 dies quietly at session end, never having been shown.

Findings then wait in the store. The first moment you actually see them is whichever comes first:

| Where | When |
|---|---|
| Statusline, next session | the next time you open the harness in that project |
| `/sensei:now` or `vibesenpai report` | whenever you ask |
| Weekly digest + `vibesenpai fix` | the aggregate view, where one concrete change is proposed |
| Dashboard | M3 onward |
| Desktop notification | only if explicitly opted in, session-end only |

This is also the honest argument for why mid-session batching matters: if findings only ever surfaced
after the fact, the feedback loop would be a day or a week long. `SessionEnd` is the backstop for
whatever did not surface in time — and the garbage collector for what turned out not to be true.

Deliberately **not** `PostToolUse` or `UserPromptSubmit` per-event analysis. mem0 hooks those, but it
is adding context to the session; we are observing it. Analyzing on every tool call is the polling
loop this project rules out, and the cost lands in your typing latency.

### Principle zero: a broken analyzer must never break a session

This outranks every other goal in the project, including correctness of findings. A session-analysis
tool that costs someone a working session has done more damage than it could ever repay in insight,
and it gets uninstalled immediately and permanently. It is therefore enforced in code, not asserted
in a README:

1. **Every hook exits 0, unconditionally.** `|| true` on every command, following the mem0 pattern.
   No hook can ever return a nonzero status, whatever happens inside it.
2. **Every hook has an explicit `timeout`**, set well under the harness's budget. A hung analyzer
   gets killed, not waited on.
3. **Analysis is detached, never in-process.** The hook spawns and exits; the analyzer cannot hold a
   session open, and killing the session cannot corrupt a half-written analysis.
4. **The catalog is written temp-then-rename**, so a crash cannot leave it half-written. And the
   offset never advances past a complete line, so a partial record is re-read rather than skipped.
5. **Never write to the harness's own files.** We read `~/.claude/projects` and never open it for
   writing. The transcript is the user's record, not our scratch space.
6. **Circuit breaker.** If the detached analyzer fails N times in a row, the hook self-disables and
   records why. `vibesenpai doctor` reports it. Degrading to silence beats degrading to noise.
7. **A kill switch that always works:** `VIBESENPAI_DISABLE=1` short-circuits every hook on the
   first line, before any logic runs — so recovery never requires uninstalling or editing JSON.
8. **Tested adversarially:** the M6 suite runs hooks with a corrupt catalog, a full disk, a missing
   binary, a killed analyzer mid-write, and a read-only data dir. Pass condition is that the session
   is unaffected in every case.

`PreCompact` deserves emphasis: compaction is exactly when context decay happens, and it is the
moment the evidence for it gets summarized away. Capturing there is a capability no retrospective
tool reading only finished transcripts can have.

### When does it speak: batched, at the response boundary

**Chosen model.** Analysis runs mid-session in batches. When a batch finishes, the findings surface
*subtly, after an assistant response completes* — never mid-response, never while you are typing.
Everything is also available on demand through a skill, the way `/insights` works.

| Moment | What surfaces |
|---|---|
| **Session start** | **the aggregate standing — pre-computed, no work to interrupt yet** |
| Mid-response | nothing, ever |
| At a **chunk boundary**, if a batch finished | one short statusline segment, confirmed findings only |
| On `/sensei:now` | everything, including provisional in-flight findings |
| Session end | nothing shown — findings are finalised and stored (see below) |
| Weekly digest | trends + the one thing to apply |

### Session start is the best moment there is

The strongest moment for the aggregate view, for three reasons: **there is no work in progress to
interrupt**, the numbers were already computed at the end of previous sessions so there is no
latency, and it answers a question the user actually has — *where do I stand?* — rather than
volunteering something they did not ask about. It also resolves the "if I am gone, where do I see
this?" gap: session end finalises and stores; **session start is where it surfaces.**

**But the channel problem is real and must not be fudged.** A `SessionStart` hook's stdout goes into
the *agent's* context, not the user's terminal — verified earlier. So a report at session start is
relayed by the model, exactly as mem0's own plugin does (its hook literally instructs the model to
print its status line). That works in practice, and the cost at one injection per session is trivial
(~100 tokens).

**The distinction that keeps it honest: statistics do not contaminate; instructions do.**

| Session-start content | Effect | Verdict |
|---|---|---|
| *"last 7 days: 14 sessions, 3 rework loops, 72% of edits verified"* | reports numbers; tells the agent to do nothing | **safe — this is the default** |
| *"remember: this repo uses pnpm, violated 7× last week"* | instructs the agent; changes the session being measured | **an intervention — opt-in, and labelled as suppression in trends** |

The first is a report to the *user* that happens to pass through the agent. The second is a
**brief** — effectively a dynamically selected, evidence-ranked `CLAUDE.md` line injected where
attention is freshest, which is plausibly more effective than a static buried rule. It may be the
best intervention in the catalogue. But it perturbs the measurement by design, so it is opt-in, and a
dimension under an active brief is reported as *suppressed* rather than *improved* — the same rule
that governs guards.

Default session-start output stays terse, ~3 lines, and is skippable with one config flag:

```
  vibesenpai · last 7d: 14 sessions · 72% of edits verified · 3 loops unresolved
  ⌁ pnpm constraint violated 7×

  Run /sensei:now to view more details.
```

### "After a chunk of work" — what a chunk actually is

Not every response boundary. A *chunk* is a completed unit, and the useful property is that these are
moments when the user's attention is naturally resetting anyway. All of them are detectable from the
event stream without guessing:

| Chunk signal | Why it is a good moment |
|---|---|
| A commit landed | the work was banked; a natural pause |
| Verification went failing → passing | the task just resolved |
| A `TodoWrite` list completed | the agent itself declared the unit done |
| A compaction occurred | the context just reset; so has attention |
| N turns since the last nudge, with a window closed | the fallback, so long sessions are not silent |

Preferring these over "every N boundaries" means nudges land where a human would naturally look up,
rather than on an arbitrary counter — which is the difference between a cue and an interruption. A
response boundary mid-task is still *safe* (the statusline cannot interrupt), but it is not *useful*,
because nobody looks up mid-task.

The response boundary is the right moment because it is the one natural pause in a session: the
agent has stopped, you have not started. It costs no typing latency and interrupts no output.

**The consequence: analysis cannot run inside the hook.** A `Stop` hook has a timeout budget, and
blocking it to run detectors would add latency to every single response — the exact "light footprint"
violation this project rules out. So the ambient layer is a **producer/consumer queue**, not a
synchronous analyzer:

```
Stop hook fires (budget ~10ms, `|| true`):
  1. drain: is there a finished analysis in the queue? → print it, mark surfaced
  2. advance the catalog over new transcript bytes (incremental, offset-tracked)
  3. has a window (6–12 turns) just closed? → spawn DETACHED analysis, exit immediately
                                                 ↓
                                  writes findings to the queue when done
                                  → surfaces at the NEXT response boundary
```

The hook never waits for analysis. A batch analyzed during turn 14 surfaces at turn 15's boundary,
which is also why batching is honest rather than a limitation: a finding is about a *window*, and the
window has to close before the finding exists.

**Three anti-nag rules, enforced in code, because this is the surface that gets a tool uninstalled:**

1. **Never repeat a finding.** Dedup by finding identity (detector + evidence turn range) across the
   whole session, persisted so a resumed session does not re-announce.
2. **Rate limit.** At most one ambient surfacing per N response boundaries, regardless of queue depth.
   The rest waits for `/sensei:now` or session end.
3. **Confirmed only.** Provisional findings — in-flight rework loops whose outcome is unresolved —
   never surface ambiently. They exist only when you ask.

Silence stays the default: a clean session produces no output at all, and that silence is
information.

### Superseded 2026-10-19 — `systemMessage` is a user-visible channel

**The table below is wrong in its conclusion, and the reason is new evidence rather than a change of
mind.** When it was written, the only known way to reach the user was the statusline, because hook
stdout demonstrably goes to the model's context. That remains true of *stdout*. It is not true of the
hook's **JSON `systemMessage` field**, which was not examined.

Established by reading Anthropic's own plugins rather than the docs — the `plugin-dev` skill calls
`systemMessage` an "Explanation for Claude", and is contradicted by both:

- `claude-security/hooks.py` prints an **ASCII-art logo box** through `systemMessage`. Nobody renders
  ASCII art for a language model.
- `security-guidance` names it in a comment: *"user-visible TUI message"*, explicitly distinct from
  `hookSpecificOutput.additionalContext`, *"SessionStart's supported channel for surfacing text to
  **both the model and the user**"*.

So the observer-effect objection that drove the statusline choice **does not apply to
`systemMessage`**: it reaches the user and not the model. The report now renders in the main window
at session start, and the statusline is removed — **zero of ~40 official plugins ship one.**

What survives from the analysis below: context injection is still rejected, `UserPromptSubmit` is
still never used for surfacing, and direct terminal writes are still banned. Only the *channel* changed.

### The surfacing channel — verified, and not the obvious one

**Hook stdout is NOT user-visible. It is injected into the model's context.** Verified by reading this
session's own transcript: hook output lands as `hook_success` / `hook_additional_context` attachment
records with `stdout` captured into `content`. The proof by construction is mem0's SessionStart hook,
whose stdout reads *"IMPORTANT: In your FIRST response, display this exact status line as your opening
line"* — a production plugin has to **ask the model to print for it**, because it cannot print itself.

So the chosen ambient model is right but the mechanism is not "the hook prints a line." Four channels
exist, and the choice matters more than it looks:

| Channel | User-visible | Verdict |
|---|---|---|
| Hook stdout → model context → model relays | indirectly | **Rejected — see below** |
| **Statusline** | yes | **Chosen.** Subtle by construction, persistent, no context cost |
| Direct terminal write (`/dev/tty`, OSC codes) | yes | **Banned.** Writing into a running TUI is exactly the distraction risk this must not take — and `"tui": "fullscreen"` makes it a corruption risk too |
| Desktop notification | yes | **Never during a session.** Opt-in, session-end only |

**Why context injection is rejected, and this is the important one:** feeding "you are in a rework
loop" into the agent's context *changes the agent's behavior mid-session*. The tool would then be
measuring a session it has itself perturbed — an observer effect that corrupts the evidence, breaks
the before/after comparison the trends feature depends on, and makes "we measured your habits"
false. An analyzer must not be a participant. It also burns context tokens on every boundary and
makes the finding read as if Claude said it, which muddies exactly the authorship the evidence
principle cares about.

So: **the `Stop` hook writes findings to the queue; the statusline renders them.** Same batched,
post-response, subtle behavior the model calls for — the hook just updates state instead of printing.
`/sensei:now` remains the full-detail channel, and the queue is read by both.

This resolves at design time what would otherwise have been discovered at M6 after the ambient layer
was built on an assumption. The one thing still to confirm empirically is statusline refresh timing
relative to the `Stop` boundary — cheap to test with a stub statusline script in M3.

### Principle one: the live surface must never interrupt

Ranking just below "a broken analyzer must never break a session", and enforced the same way — in
code, not in a README.

> **Nothing `vibesenpai` surfaces during a session may interrupt, distract, or delay the user. It
> never touches their prompt. The worst acceptable outcome is that a nudge goes unnoticed.**

**The key move is choosing a channel that structurally cannot interrupt, rather than trying to time
an interruption well.** Timing heuristics would be fragile — hooks do not fire on keystrokes, so we
can never actually know whether someone is mid-thought or mid-sentence. The statusline makes that
moot: it is a passive render that steals no focus, injects no text, blocks nothing, and **waits to be
looked at** instead of demanding attention. It is read when the user's eyes happen to land there,
which is by definition a moment they were not busy.

**Banned outright, no fallbacks:**

- `UserPromptSubmit` for surfacing — it can block or rewrite a prompt, so it is never used for this
- Hook stdout as a surfacing channel — it lands in the agent's context, so Claude would *talk about
  it*, polluting the conversation and derailing whatever the user was reading
- `/dev/tty` writes and OSC escape codes — drawing into a live TUI
- Terminal bell, and any desktop notification mid-session
- Anything modal, anything that moves the cursor, anything that scrolls

**Timing rules on top of the safe channel:**

1. **Never mid-response.** The line updates only at a completed response boundary, never while output
   is streaming — a line that changes under a moving cursor catches the eye even if it is passive.
2. **Never on the first boundary of a session.** Let someone get into flow before anything appears.
3. **Rate-limited** to at most one change per N boundaries, regardless of how deep the queue is.
4. **It decays.** An unacted nudge disappears after N boundaries rather than sitting there
   accumulating guilt. Findings persist in the store; the *nudge* does not.

**Content rules — what "subtle" means concretely.** Subtle must still be *legible*: a bare count
(`⌁ 2`) is unreadable and therefore useless — nobody investigates a number with no referent. The
nudge states **the most significant finding as a plain fact**, plus a count of the rest, plus where
to look:

```
  ⌁ pnpm violated 7×
  ⌁ 3 edits unverified · +2 more
  ⌁ "all tests pass" said while 2 failing
```

Format: `⌁ <top finding as a fact> [· +N more]`, capped around 40 characters.

**The `/sensei:now` pointer does not belong on the nudge.** Repeating it on every line is noise, and on a
shared statusline those characters are better spent on the finding itself. The pointer appears **once,
as a footer**, in the multi-line surfaces where there is room for it — the session-start report and
`report` output:

```
  vibesenpai · last 7d: 14 sessions · 72% of edits verified · 3 loops unresolved
  ⌁ pnpm constraint violated 7×
  ⌁ 3 edits unverified · +2 more

  Run /sensei:now to view more details.
```

One exception, because discoverability matters exactly once: **the first nudge a user ever sees
includes the pointer**; every subsequent one drops it. That is a single boolean in the state file, and
it means nobody has to be told twice.

What makes those subtle is not brevity, it is **grammar**: every one is a statement of fact with no
imperative verb ("fix", "stop", "should"), no severity word ("critical", "warning"), no colour alarm
and no emoji beyond the single neutral marker. *"pnpm violated 7×"* is information. *"⚠ Fix your
pnpm usage!"* is a nag. The line never says what to do — only what happened, and that detail is one
command away.

**Statusline ownership — do not hijack it.** Claude Code's statusline is a single command, so
installing ours would replace whatever the user already has. Verified on this machine: `statusLine`
is unset (the existing `cc-status` is a *hook*, which writes to iTerm's own status bar, not Claude
Code's). But ccusage and vibe-log both ship popular statusline integrations, so an existing one is
common. Therefore `init` **detects an existing `statusLine` and offers to wrap it** — calling the
user's command and appending our segment — rather than overwriting it. If wrapping is declined, the
ambient surface is simply off.

**And ambient-off is a first-class configuration, not a degraded mode.** `dimensions.ambient: []`
disables live surfacing entirely, leaving `/sensei:now` and `report`. For many users that will be the
right setting, and the tool loses nothing essential — the value proposition does not depend on
nudging anyone.

### `/vibesenpai:insights` and `/vibesenpai:fix` — slash commands, without a plugin

Custom commands live in `.claude/commands/`, and `` !`cmd` `` in the body runs a
shell command and injects its output, gated by `allowed-tools` in the
frontmatter — verified in Anthropic's own `commit-commands`.

**The colon form needs no plugin, only a subdirectory.** `mem0:remember` and
`commit-commands:commit` are plugin commands, but the harness namespaces nested
user commands the same way: *"Restored namespacing in command names based on
subdirectories … `.claude/commands/frontend/component.md` is now
`/frontend:component`"*. So `commands/vibesenpai/now.md` is `/vibesenpai:insights`,
written by `vibesenpai install` and removed by `uninstall` — **no plugin
packaging**, which is what makes it affordable before M3.

`uninstall` removes the directory with `rmdirSync`, which refuses a non-empty
one: a command somebody else put there survives, and so does the folder.

Its body asks for the output verbatim: letting the model summarise would replace
evidence with a paraphrase of evidence, which is the one thing this project will
not do.

Same caveat as the hooks (D54): the path is absolute, so moving the checkout
breaks it until re-install.

### Command surface

```
  vibesenpai init                    detect harnesses, install plugins (asks first)
  vibesenpai insights                     report on the current / most recent session
  vibesenpai report --last 7d        retrospective; --since/--until/--project
  vibesenpai trends --weekly         improvement over time
  vibesenpai explain <id>            the evidence: exact turns, verbatim
  vibesenpai dismiss <id> --wrong    "this was TDD, not rework" → feeds the gold set
  vibesenpai fix                     the ONE next action + tier + evidence + baseline
  vibesenpai fix --guard <name>      generate the hook for it (printed, consent required)
  vibesenpai claude-md               audit CLAUDE.md: ceremonial / ineffective / working
  vibesenpai goal <dimension>        set a target; tracks baseline → delta
  vibesenpai dashboard               localhost UI
  vibesenpai scan                    read new transcript data (copies nothing)
  vibesenpai doctor                  harnesses, backends, paths, retention warning
  vibesenpai config                  resolved values + which layer set each
  vibesenpai eval                    three-tier scoreboard
  vibesenpai uninstall               remove exactly what init added
```

### In-session slash commands

Verified on disk: Claude Code plugins ship `commands/*.md` — markdown files with YAML frontmatter
(`description`, `allowed-tools`) that the model executes. `commit-commands` is the reference format.

**Commands are always namespaced `<plugin-name>:<command>`** — confirmed against three installed
official plugins (`/commit-commands:commit`, `/hookify:configure`,
`/claude-md-management:revise-claude-md`). **A bare `/sensei` is therefore impossible from a plugin.**
Earlier drafts of this document wrote `/sensei`, which was simply wrong.

Two consequences, and the audience decides them:

- **The plugin is named `vibesenpai`, not `sensei`** — giving `/vibesenpai:insights`. Shipping to
  strangers means the plugin namespace is shared with everything else they install, and a generic
  `sensei` invites collision. The npm package and plugin name match, which also avoids explaining a
  discrepancy in the README.
- **`init` optionally installs a bare `/sensei` shortcut** as a user-level command in
  `~/.claude/commands/sensei.md`, which *is* un-namespaced. Offered, never assumed, printed before
  writing, and removed by `uninstall` — the same consent rule as every other config write.

The plugin ships these (shown with the shortcut installed; otherwise `/vibesenpai:*`):

```
/sensei:now              report on the current session        → vibesenpai insights
/sensei:why <id>         the evidence, verbatim turns         → vibesenpai explain <id>
/sensei:report [7d|30d]  retrospective over recent history    → vibesenpai report --last
/sensei:fix              the one next action + evidence       → vibesenpai fix
/sensei:dismiss <id>     "that was TDD, not rework"           → vibesenpai dismiss --wrong
```

Each is a thin `commands/*.md` that runs the bundled CLI with `--json` and presents the result. This
is exactly how Anthropic's own `session-report` plugin works — `node <skill-dir>/analyze-sessions.mjs
--json --since 7d`, then the model renders it — so the pattern is both proven and idiomatic. We also
adopt its `--since` vocabulary (`24h`, `7d`, `30d`, `all`) rather than inventing our own, since users
will already have seen it.

**This also resolves the observer-effect tension cleanly, and the distinction is worth stating
explicitly:**

- **Ambient / unrequested** → statusline only. Never injected into the agent's context, because
  perturbing a session we are measuring invalidates the measurement.
- **On demand via `/sensei:now`** → the model runs the CLI and presents the output. Context cost and
  influence are *fine here*, because the user asked. Asking is itself an intervention they chose.

The CLI is the single implementation; both the harness commands and the external binary are thin
wrappers over the same code paths, so there is no second analyzer to keep in sync.

Three changes from the originally planned list, all deliberate:

- **`scan` is the catalog command.** It advances the offset over new transcript bytes and copies
  nothing. `report` scans first if it needs to.
- **`hooks install` becomes `init`.** It is multi-harness now, and "set me up" is the actual intent.
- **`explain` and `dismiss` are new, and they are load-bearing.** `explain` is how "evidence, not
  vibes" becomes a thing you can *do* rather than a claim in a README. `dismiss --wrong` is how a
  false flag becomes training data instead of lost trust — and it is the mechanism that grows the
  gold set from real use.

---

## The running score — problems first, with deltas

Reversing an earlier draft: **problems lead, strengths follow.** Someone running this wants to know
what is costing them, and burying that under praise reads as evasive. Strengths still get real
billing with the same evidentiary standard — they come second, not last.

And every finding carries a **running delta**, so the report is a scoreboard rather than a snapshot:

```
vibesenpai · past 10 sessions

  COSTING YOU
  constraint_decay     "use pnpm, never npm"        ×2    ↓20% since last   ↓50% all time
  no_verification      23 of 41 edits unverified          ↑5%  since last   ↓10% all time
  rework_loop          auth.ts unresolved           ×5    ↑5%  since last   ↓10% all time
  inaccurate_self_report  "all tests pass" (2 failing) ×1  2 → 1            ↓60% all time

  DOING WELL
  convergent_iteration 11 of 13 loops resolved            ↑12% since last   ↑30% all time
  effective_correction you name the error 78% of the time ↑4%  since last   ↑22% all time
```

**This reframes trends from a long-horizon promise into an always-present tally.** An earlier draft
called "proves improvement" the weakest differentiator because it takes weeks to pay off and asks for
belief up front. A running score has neither problem: it is on screen every run, it needs no
commitment, and it is the thing that makes someone come back — the second run is *more* interesting
than the first, which is precisely what a pure analyzer lacks.

### Four things that have to be right, or the numbers lie

**1. Deltas are computed on rates, never raw counts.** Ten sessions this period versus ten last period
are not comparable if the sessions differ in length. Every dimension has a natural denominator:

| Dimension | Denominator |
|---|---|
| `no_verification` | per edit |
| `user_correction`, `vague_correction` | per turn (matches the 45.7% published baseline) |
| `constraint_decay`, `tool_loop`, `rework_loop` | per session |
| `inaccurate_self_report` | per success claim |

The **count** is displayed because it is concrete and checkable; the **delta** is computed on the rate
because that is the only comparable quantity.

**2. No percentages on small numbers.** Going from 2 occurrences to 3 is "+50%", and reporting it that
way is fake precision — exactly what this project exists not to do. Below a minimum denominator the
display shows the raw transition instead (`2 → 1`), and a percentage appears only once the sample
supports it. This is the same discipline as the confidence tiers, applied to arithmetic.

**3. Direction is per-dimension, not universal.** "Down" is good for `rework_loop` and bad for
`convergent_iteration`. Some dimensions have no good direction at all — more `user_correction` is not
a failure, since correcting the agent is healthy. So the schema needs an explicit polarity:

```ts
polarity: 'lower-is-better' | 'higher-is-better' | 'neutral'
```

`neutral` dimensions show their delta without a value judgment — they are context, not score.

**4. A suppressed dimension is not an improved one.** If a guard is installed for
`constraint_decay`, its count drops to near zero *by construction* — the guard is preventing it, the
user did not change. Reporting that as improvement would be the tool flattering itself. Guarded
dimensions are therefore labelled:

```
  constraint_decay    "use pnpm, never npm"       ×0    guarded since Oct 9 — suppressed, not improved
```

### Incremental persistence: results land as they are computed

Findings are written to the store **as each window completes**, not batched at the end of a run. Three
reasons, and the first is what the running score depends on:

1. **The score needs history.** Deltas are computed against previously stored findings, so persistence
   is not an optimisation — it is the feature's substrate.
2. **Partial results survive interruption.** A `report --last 30d` killed halfway has still banked
   everything it analysed; the next run resumes rather than restarting.
3. **It is what feeds the ambient queue.** The `Stop` hook's detached analyzer writes findings as it
   goes, and the next response boundary drains whatever is ready — which is exactly the
   producer/consumer design already specified.

**Schema consequence — denominators get stored, so rates are a query rather than a re-parse.** The
`sessions` table gains the counts every rate needs:

```sql
sessions(..., turn_count, edit_count, tool_call_count, verified_edit_count,
              success_claim_count)
```

With those, every delta in the display above is a SQL aggregate over `findings` joined to `sessions`
within two date windows. **No rollup table in the MVP** — computing from findings avoids a staleness
class of bug entirely, and a rollup cache is added only if measurement shows the aggregate is slow.

### Window semantics, stated in the output

"Past 10 sessions" and "since last" need to be unambiguous or the number is unreadable:

- **`past N sessions`** — the N most recent sessions, not N days. Sessions are the unit a developer
  recognises.
- **`since last`** — the immediately preceding window of the *same size*: sessions 11–20 for a
  10-session view. Equal-sized windows, or the comparison is meaningless.
- **`all time`** — everything catalogued. Which, honestly, begins when `vibesenpai` was installed, so the
  output says so (`all time (since Oct 9)`) rather than implying it knows about anything earlier.

`vibesenpai report --last 7d` switches the window to days; the deltas follow the same rules with days
as the unit.
---

## Two surfaces: live in-session, and async retrospective

These are different products sharing a detector core, and a flat command list
(`scan`/`report`/`dashboard`) hides that. Separating them changes what M1 must support.

### A. Live — `vibesenpai insights`

Run it mid-session, in another terminal or via `!vibesenpai insights`, and get a report on the session you are
in right now. This is the habit loop: feedback while it can still change the session's outcome.

```
$ vibesenpai insights

vibesenpai · current session · 47 turns, 2h14m

  constraint_decay     turns 31, 44             high
  └─ "use pnpm not npm" restated after 13 turns

  repeated_instruction turns 8, 22, 44          high
  └─ 3× same constraint → suggest a CLAUDE.md line

  ~ fail-fix cycle in progress   turns 38-47     provisional
  └─ 3 identical test failures, outcome not yet known
```

**Two architectural consequences, both of which land in M1:**

1. **Live mode tails past the catalogued offset.** The current session's transcript is still being
   appended to, so `now` reads from the last catalogued offset to the end of the file rather than
   waiting for a scan. The same incremental offset reader serves both, so this is
   a parameter, not a second code path. Hooks receive the transcript path directly, which is how the
   automatic version at M6 locates it.
2. **The current session is incomplete, and that is a precision problem, not a detail.** Outcome
   classification cannot resolve mid-flight — flagging `rework_loop` at turn 14 when turn 16 would
   have passed the test is exactly the false flag that principle #2 forbids. So live mode splits
   findings by whether they need an outcome:
   - **Safe live:** constraint decay, repeated instructions, clarification churn, inaccurate
     self-reporting, interrupts. These are already definitively true when observed.
   - **Provisional only:** rework loops and fail-fix-fail, shown as "in progress, outcome not yet
     known" and never as a confirmed finding.

   This split is a schema-level flag on every detector (`requiresOutcome: boolean`), decided in M1 so
   M2's detectors declare it as they are written.

### B. Async — `vibesenpai report`

Retrospective across history, with date and project filters:

```
vibesenpai report --last 7d
vibesenpai report --since 2026-09-01 --until 2026-10-01
vibesenpai report --project ode --last 30d
vibesenpai trends --weekly            # improvement over time
```

**This surface has two depths, because of the data loss** — and it is worth stating in the CLI output
rather than letting a date range silently return nothing:

| Date range | Available depth |
|---|---|
| From the first scan forward, within the harness TTL | **Full** — tool calls, outcomes, every detector |
| Before that | **Prompt-level only** — the 899 prompts in `history.jsonl`, which survives cleanup |

The shallow tier is more useful than it sounds: 899 prompts over 10 months supports prompt-quality
trends, vague-prompt detection (→ S2 Misread Intent / C1 Underspecified Instruction), and repeated
instructions across sessions. So the async surface returns real value on day one despite zero
surviving transcripts, and `report` labels which depth each period came from instead of implying
uniform coverage.

`vibesenpai dashboard` (M3) is the visual form of this surface; `now` stays terminal-only.

**Milestone effect:** the detector core (M2) gates both, so the ordering holds. But the CLI shape,
the live/catalogued reader parameter, and the `requiresOutcome` flag move into **M1** — they are cheap
now and expensive to retrofit. `history.jsonl` parsing is promoted from an open item to an **M2
deliverable**, since it is the only thing backing the async surface's historical range.

---

---

*Extracted from the planning document (2026-10-12/15). Reasoning is kept with each
conclusion deliberately — see [DECISIONS.md](../DECISIONS.md) for the index.*
