# Documentation

Split from the planning document (2026-10-12/15). Reasoning is kept with each conclusion
deliberately — see [DECISIONS.md](../DECISIONS.md) for the decision index with pointers here, and
[GRAVEYARD.md](../GRAVEYARD.md) for what was built, measured, and removed.

| Doc | What it covers |
|---|---|
| [architecture.md](architecture.md) | **Start here.** Pipeline, flow diagrams, module map, and the invariants |
| [dimensions.md](dimensions.md) | **What the tool actually detects**, with the measured frequency and hand-verified precision for each — plus selection presets and config |
| [dimension-survey.md](dimension-survey.md) | The 40-dimension catalogue from five published taxonomies. A **literature survey, not a backlog** — kept because the research is sound, marked because it must not be built from |
| [findings-frequency.md](findings-frequency.md) | What we measured over 1,139 real sessions, and the five probes that were wrong in the same way |
| [surfaces.md](surfaces.md) | Install model, hooks, the two surfaces (live / retrospective), the running score, and both principles |
| [artifacts.md](artifacts.md) | How a finding becomes a prompt, a guard, or a rule diff — and the evidence on what actually works |
| [models.md](models.md) | Semantic analysis: model selection with sizes, the cascade, download policy, reference implementations |
| [contracts.md](contracts.md) | The three pinned contracts (TurnRef, Finding, Skeleton) and the SQLite schema |
| [log-formats.md](log-formats.md) | Claude Code's transcript format as observed, with inferred claims labelled |
| [data-sources.md](data-sources.md) | SWE-chat and the other corpora, licences, and parser-reuse verdicts |
| [prior-art.md](prior-art.md) | Competitive landscape and an honest read on what differentiates this |
| [distribution.md](distribution.md) | Marketplace tiers, publishing, packaging, the install-time offer |
| [eval.md](eval.md) | The three scoreboards: synthetic, silver, gold |
