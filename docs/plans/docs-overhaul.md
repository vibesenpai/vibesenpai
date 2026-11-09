Status: approved 2026-11-08. Part A shipped in 3e54a44; Part B in progress.

# Fewer commands, then a docs overhaul

## Context

The docs site (`site/`, Starlight 0.30.3 on Astro 5.1.1, 20 pages) and the README describe an earlier
product. An audit against the code (2026-11-08) found:
- **Spend described backwards on six pages.** The judge runs from the `Stop` hook, on by default, within
  2M tokens a day and a 200-session catch-up.
- **No mention of the main surfaces:** the pane, Apply, the fix marker, Before / Since.
- **Samples today's code can't produce.**
- **Twelve unsourced numbers.**
- **"Rules" wording** where customers should read "the free checks".
- **A README with no link into the site.**

While planning, the user chose to cut the slash commands to a minimum first. `fix`, `apply` and
`dismiss` duplicate the pane. Removing them leaves three: `/vibesenpai:insights` (opens the pane),
`/vibesenpai:judge on|off` (the one switch for spending), and `/vibesenpai:report` (the HTML report).
Code changes come first, so the docs are written once, for the final product.

Decided with the user:
- **Reader:** someone deciding whether to install.
- **Screenshots:** from a demo project.
- **Home page:** custom, approved as a mockup first; Starlight with brand colours elsewhere.
- **README:** short (install and getting started), everything else on the site.
- **Dimensions:** their own section, one page each.
- **Commands:** their own section; no "Using it" section.
- **Repo:** `vibesenpai/vibesenpai`.

## Part A: remove `fix`, `apply`, `dismiss`; the pane covers them

The CLI subcommands `fix`, `dismiss` and `label` stay. The pane calls `dismiss` and `label`
(`hooks/pane.tsx:119,139,151`), and D64 already makes the CLI the engine, not a human interface. Only the
slash commands go.

1. **Delete** `commands/fix.md`, `commands/apply.md`, `commands/dismiss.md`. Remove the `fix --apply`
   branch in `src/cmd/fix.ts:43-58`. The pane is now the only way to apply.
2. **Per-finding fixes in the pane** (the only part of `fix` the pane lacks; D67 says a finding's own fix
   comes first):
   - `src/cmd/report.ts` `fixesFor` (`:279-299`) adds the finding fixes from `src/finding-fix.ts`
     `fixesFor`, `pickFindingFix` and `findingPlan`, read through `sessionForFix` (`src/cmd/common.ts:147`).
   - `PaneFixState` (`types/index.d.ts:55-69`) gains `findingId`, `kind`, `applicable`, `project` and
     `source.quote`. `target` widens to every `ApplyTarget`.
   - The pane's Fix section and Fixes tab show a finding's own fix in place of its dimension's.
     `KIND_WORDS` supplies the kind line. A fix from another project, or a printed-only Stop hook, is
     shown with no Apply and the existing refusal sentence (`src/cmd/fix.ts:80-84`).
   - **Risk:** this parses each judged session during `report --json`. Measure it first. If it pushes the
     pane's first load past a few seconds, compute it in the standing pass (`scripts/compute-standing.ts`,
     which already parses every session) and store it with the standing.
3. **Apply fallbacks** (`hooks/pane.tsx:159-188`): no prompt box → copy to the clipboard. If the copy also
   fails, show the request text in the pane to copy by hand. Nothing names `/vibesenpai:apply`.
4. **Dismiss in bulk:** the pane gets **Hide all** (`dismiss --all`) on the Findings tab and **Restore
   all** (`dismiss --undo all`) on the Health tab's Dismissed row. Per-row Hide and Undo already exist.
5. **Pointers to removed commands:**
   - `src/session-block.ts:138-142`, `src/cmd/insights.ts:207-208` and `nextRung` point at
     `/vibesenpai:insights` (and `/vibesenpai:report`).
   - `src/fix.ts:498` stops naming `/vibesenpai:dismiss undo all`.
   - `src/cmd/dismiss.ts:120` says "Undo in the pane".
6. **Rules and decisions:**
   - `.claude/rules/fixes.md`: the pane's Apply is the only yes; drop "/vibesenpai:apply is the same yes".
   - **DECISIONS.md D70:** three slash commands; the pane is where findings are acted on. Supersedes the
     apply and dismiss command parts of D65 and D67.
   - CHANGELOG.
7. **Tests:**
   - Update `test/commands.spec.ts` and the `nextRung` test.
   - `hooks/pane.test.tsx`: per-finding fix shown and applied, refusal shown without Apply, Hide all and
     Restore all, clipboard fallback.
   - `test/docs.spec.ts`: the shipped commands list.

## Part B: the docs

### Sections (sidebar in `site/astro.config.mjs`; surviving slugs kept)

| Section | Pages |
|---|---|
| **Start** | Home (custom) · What it shows you · Install and update · A tour of the pane (new) · Your first finding · Fixes and Apply (Apply drafts into the prompt box, your Enter is the yes, the marker, Waiting / Applied, Before / Since, "not in effect yet") |
| **Dimensions** | Overview (each dimension's tier, default, confidence; secondary kinds; why `other` exists) · Misread intent · Constraint violation · Inaccurate self report · Overreach · Other · Edit retry · Repeated call · Cache rebuilds |
| **Commands** | `/vibesenpai:insights` (the pane; text version where no pane can open) · `/vibesenpai:judge` (on by default, on/off, limits, catch-up, backlog, failures, what it spends) · `/vibesenpai:report` (what the HTML contains) |
| **Trust** | What leaves your machine, and what it costs (rewrite) · How accurate it is · Limits · What we do not detect · The graveyard · What else is out there |
| **Reference** | Settings, environment variables, files and what losing each costs (`store.db`) |
| **Under the hood** | Overview · Phases of a run (rewrite: Stop-hook spend, job supervision) · Reading a transcript · The two tiers · The judge pipeline (windows, lookback, secondary kinds) · Design decisions (add D58, D64–D67, D69, D70) · Releases and install counts (D69) |
| **Contribute** | `now` → `insights`, `npm run test:pane`, the release process |

### Dimension page template

Each dimension page has five sections, in this order:

1. **The dimension.** Name as the pane shows it, key, tier, default on or off, confidence. Sources:
   `src/judge/prompt.ts:11-53`, `src/detect/index.ts:21-23`, and each detector's preset.
2. **Description.** What it means and what it doesn't, and where it borders its neighbours. Frequency only
   from `docs/findings-frequency.md` / `docs/eval.md`, with the date. Overreach says it does not work.
3. **Example conversation.** A real exchange from the demo corpora, as the pane shows it. Where the demo
   has no instance, it is marked **illustrative** and never presented as found.
4. **How it's detected.** The mechanism, plus a Mermaid diagram (`site/src/diagrams/<dimension>.mmd`
   rendered to SVG):
   - Model reads: extract → label → quote anchoring → lookback gate.
   - Free checks: the structural events read, the firing condition, the reason labels
     (`src/detect/edit-retry.ts`, `src/detect/labels.ts`, `src/detect/redundant-call.ts`, `src/stats.ts`).
5. **Applicable fixes.** Every fix offered for this dimension, with its kind, text, where it lands, and
   whether it has Apply:
   - from `src/fix.ts` `BY_DIMENSION` / `ARTIFACTS`
   - per-finding fixes from `src/finding-fix.ts`
   - "no fix" stated plainly where there is none

### Rules the rewrite holds

- **Voice:** two outputs, never a third; statements of fact.
- **Numbers:** every number traces to `npm run measure`, `docs/eval.md`, GRAVEYARD.md or code, with a
  date. Unsourced ones are sourced or cut.
- **Samples:** come from the demo run; slash commands only, never the binary.
- **Wording:** "the free checks", never "rule findings".
- **`test/docs.spec.ts` keeps passing:**
  - the pitch verbatim in `index.mdx` and the config
  - README keeps `/vibesenpai:insights` before `## Contributing`, and keeps `/plugin disable vibesenpai`
  - no unknown `npm run` scripts
  - no `vibesenpai <word>` unless the word is a real CLI case
  - lead-line shapes from `src/render.ts:434-450`
  - diagrams re-rendered after edits
- **Raw harness data:** never copied; demo transcripts are fetched from public pinned corpora, never
  vendored.

### Steps

1. **Demo environment** (`scripts/demo.sh`, dev-only)
   - Fetch the two MIT corpora pinned in `scripts/corpus.json` into a temp dir, in the
     `projects/<cwd>/<id>.jsonl` layout.
   - Point `VIBESENPAI_SOURCES` and `VIBESENPAI_ARCHIVE` at throwaway dirs.
   - Run the free checks, then a small, capped `judge --backlog --apply`. This is the plan's only spend;
     I'll give the estimate and ask before it runs.
   - First check whether the pane's `$.process.run` inherits those variables
     (`hooks/pane.tsx:33-37`). If not, use a temporary `VIBESENPAI_CONFIG` file.
2. **Screenshots:** you take the pane shots, from a shot list I prepare. The HTML report is generated
   with `--source --archive --out`. Every image is checked for anything outside the demo corpora.
3. **Home page mockup** for your approval:
   - brand tokens: mark `#0d1117` / `#7fb3d5` / `#e6edf3`, report accents `#1f5f8b` / `#7fb3d5`
   - the mascot hero
   - a real pane screenshot
   - the pitch, three steps, the trust facts, install
4. **Site shell:**
   - `customCss` with the brand tokens
   - the custom home (Starlight `splash` plus a component in `site/src/components/`)
   - the new sidebar
   - `findings/dimensions` redirects to the new overview
5. **Pages,** in section order. The dimension diagrams join `site/src/diagrams/`; re-render
   `pipeline.mmd` and `hook-lifecycle.mmd`.
6. **README:**
   - pitch and one screenshot
   - install, then getting started: open insights → read a finding → Apply
   - one paragraph on what leaves the machine, with a link
   - links into the site
   - a short `## Contributing`
7. **CHANGELOG `[Unreleased]`:**
   - correct "Off by default", "agentsensei" and "three slash commands"
   - add the pane, Apply, the judge command, limits, job supervision, D69 and D70
8. **Drift guards** in `test/docs.spec.ts:**
   - every `commands/*.md` has a Commands page
   - every dimension in `src/judge/prompt.ts` / `src/detect/index.ts` has a Dimensions page
   - every user setting in `src/config.ts` is on Reference
   - every internal site link resolves (`walkSite`)

## Found, not in scope

Reported separately; the docs describe today's behaviour around them.
- `redundant_call` is off by default (preset `core`).
- The HTML report shows raw `snake_case` names.
- The disclosure hard-codes "Haiku" and "60k".
- The `doctor` network text is stale.
- `judge --daily-tokens` and `--catch-up` are missing from the usage text.
- Codex is a default source with no parser.

## Verification

- **Part A:**
  - `npm test`, `npm run typecheck` and `npm run test:pane` pass.
  - `report --json` timing measured before and after.
  - In a real session, check: a per-finding fix shows and Apply drafts it; Hide all, then Restore all;
    `/vibesenpai:fix`, `/vibesenpai:apply` and `/vibesenpai:dismiss` are gone after `/reload-plugins`.
- **Part B:**
  - `npm test` passes, including the drift guards.
  - In `site/`: the build succeeds, links resolve, and pages are read rendered in light and dark at phone
    width.
  - Samples and screenshots come from the demo run; numbers are checked against their sources.
  - The home page matches the approved mockup.
- Nothing is pushed, tagged or published. The uncommitted release work (D69) is committed separately
  first, with your OK.
