# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Pre-alpha. Nothing has been released yet. Releases ship as a zip on a tagged GitHub release (D69); npm is not used.

### Changed

- **Renamed from agentsensei to vibesenpai** (D68). Commands are `/vibesenpai:*`, environment
  variables `VIBESENPAI_*`, the data folder `~/.local/share/vibesenpai`, the rules file
  `.claude/rules/vibesenpai.md`. Fix markers and judge folders under the old name are still
  recognised. The pitch: *Discover how your agents failed you.*

### Added

- **A fix for each finding, built from its evidence** (D67). A command the developer forbade becomes
  a `permissions.ask` rule, a write outside the project a guard on that path, a broken CLAUDE.md
  line a request for a test, an earlier instruction a rule scoped to the files it was broken in.
  Questions answered with edits across sessions give a read-only `ask` subagent. Shown in `fix`, the
  HTML report and the pane; outcomes count the fix's own constraint.
- **`edit_retry`** — the first fully-measured detector. Fires on 380 of 1,139
  real sessions (33.4%), 927 instances, every one `certain`, **0 false
  positives** hand-verified.
- **`redundant_call`** — reported, with no fix offered, because re-reading a
  file is cheap and frequently correct.
- **The judge** — a model pass that reads conversation rather than
  structure, covering `constraint_violation`, `misread_intent`,
  `inaccurate_self_report`, `overreach` and `other`. Off by default.
- **Two-stage extraction**, which took session-level agreement from 129/232 to
  **165/232** and more than doubled `misread_intent`.
- **`agentsensei fix`** — one evidence-backed change, across seven artifact
  kinds, leading with the strongest enforcement tier available.
- **`agentsensei report --html`** — a self-contained report, no JavaScript, no
  external resources, mode 0600.
- **`agentsensei judge --status`** — pending sessions and an ETA from a measured
  ~30s per call.
- **Claude plugin manifest**, so `/plugin install agentsensei` works, with the
  three slash commands now in the repository rather than hand-placed outside it.
- **A docs site** under `site/`, built with Starlight, including pages on how
  this project measures itself and what it deleted.
- `LICENSE` (MIT), `NOTICE`, `CONTRIBUTING.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, and CI.

### Known limits

- **`overreach` does not work** — 2 of 38 against labelled data, across two
  models and three pipeline versions. It ships marked as such.
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
