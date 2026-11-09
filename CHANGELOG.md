# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.1-alpha] - 2026-11-08

The first release, an alpha. It ships as a zip on a tagged GitHub release (D69). The npm package
`vibesenpai` holds no code: it points to the plugin install.

### Changed

- **Three slash commands** (D70): `/vibesenpai:insights`, `/vibesenpai:judge` and `/vibesenpai:report`.
  `/vibesenpai:fix`, `/vibesenpai:apply` and `/vibesenpai:dismiss` are removed; the pane does what they
  did. It now shows each finding's own fix in place of its dimension's, says why a fix from another
  project has no Apply, offers **Hide all** and **Restore all**, and when no prompt box takes a request
  puts it on the clipboard or shows it to copy by hand.
- **Renamed from agentsensei to vibesenpai** (D68). Commands are `/vibesenpai:*`, environment
  variables `VIBESENPAI_*`, the data folder `~/.local/share/vibesenpai`, the rules file
  `.claude/rules/vibesenpai.md`. Fix markers and judge folders under the old name are still
  recognised. The pitch: *Discover how your agents failed you.*

### Added

- **A fix for each finding, built from its evidence** (D67). A command the developer forbade becomes
  a `permissions.ask` rule, a write outside the project a guard on that path, a broken CLAUDE.md
  line a request for a test, an earlier instruction a rule scoped to the files it was broken in.
  Questions answered with edits across sessions give a read-only `ask` subagent. Shown in the pane
  and the HTML report; outcomes count the fix's own constraint.
- **`edit_retry`** — the first fully-measured detector. Fires on 380 of 1,139
  real sessions (33.4%), 927 instances, every one `certain`, **0 false
  positives** hand-verified.
- **`redundant_call`** — reported, with no fix offered, because re-reading a
  file is cheap and frequently correct.
- **The judge** — a model pass that reads conversation rather than
  structure, covering `constraint_violation`, `misread_intent`,
  `inaccurate_self_report`, `overreach` and `other`. On by default after a
  one-time notice; it runs in the background after a turn ends, within 2M
  tokens a day, and `/vibesenpai:judge off` stops it.
- **The pane** — `/vibesenpai:insights` opens it beside the chat: Findings,
  Fixes and Health tabs, the conversation around a finding read in place, and
  Apply, which drafts a fix into the prompt box for the developer's Enter.
- **Before / Since** — once a fix is applied, how often the same thing happened
  before and since, in counts per project.
- **Job supervision** — background passes heal at the next hook; free failures
  retry, paid failures stop the judge after three until it is re-enabled.
- **Two-stage extraction**, which took session-level agreement from 129/232 to
  **165/232** and more than doubled `misread_intent`.
- **`/vibesenpai:report`** — a self-contained HTML report, with no external
  resources, mode 0600.
- **`/vibesenpai:judge`** — model reads on or off; with no argument, what was
  read, what is pending and what was spent.
- **Claude plugin manifest**, so `/plugin install vibesenpai@vibesenpai` works.
- **Releases as a zip on a tagged GitHub release** (D69), so installs can be
  counted from downloads without telemetry.
- **A docs site** under `site/`, built with Starlight, including pages on how
  this project measures itself and what it deleted.
- `LICENSE` (MIT), `NOTICE`, `CONTRIBUTING.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, and CI.

### Known limits

- **The kinds overlap.** An overreach is usually also a misread or a broken rule, and the
  model reads tend to name that as the main kind, with overreach as a secondary kind.
- **No gold evaluation tier.** Every accuracy figure is agreement with
  model-generated labels (*silver*), not hand-labelled ground truth. There is
  no precision number for this tool, and we will not publish one until there is.
- **Claude Code only.** The parser layer is a registry; one parser exists.

### Removed

Ten detectors were built, measured and deleted — see
[`GRAVEYARD.md`](GRAVEYARD.md). Among them: `stale_read`, where 100% of
candidates were the agent's own prior edit; `permission_denied`, where only 6
of 398 denials were ever re-issued; and `file_churn`, which fires on 48% of
sessions and could never be shown to be waste.

[Unreleased]: https://github.com/vibesenpai/vibesenpai/compare/v0.0.1-alpha...HEAD
[0.0.1-alpha]: https://github.com/vibesenpai/vibesenpai/releases/tag/v0.0.1-alpha
