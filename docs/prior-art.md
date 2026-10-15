# Prior art & differentiation

## Existing tools in this space — and an honest read on differentiation

Verified via the GitHub API and project docs on 2026-10-12.

| Tool | Stars | Lang / License | What it actually does | Overlap |
|---|---|---|---|---|
| [**vibe-log-cli**](https://github.com/vibe-log/vibe-log-cli) | 339 | TS / MIT | **The closest competitor by far.** Analyzes Claude Code + Cursor sessions; produces standup summaries, a prompt-quality score ("85/100"), coach personalities, statusline coaching, SessionStart/PreCompact hooks, optional cloud sync of sanitized patterns. | **High.** Already does coaching + hooks + statusline + prompt scoring. |
| [**ccusage**](https://github.com/ccusage/ccusage) | 18,979 | Rust / NOASSERTION | Cost and token reporting from local JSONL. No network, no account. | Low on function — but it owns the "just `npx` it at your logs" mindshare. |
| [**agentsview**](https://github.com/kenn-io/agentsview) | 6,093 | Go / MIT | Local-first session search, analytics, insights, token stats across 20+ agents; SQLite-indexed. | Medium-high on positioning ("local-first insights"), low on diagnosis. |
| [**claude-code-history-viewer**](https://github.com/jhlee0409/claude-code-history-viewer) | 2,241 | TS / MIT | Offline desktop browser/search over 11 harnesses' histories. | Low — viewer, no diagnosis. Our parser reuse candidate. |
| [**agent-loop-detector**](https://github.com/Princeu3/agent-loop-detector) | 1 | TS / NOASSERTION | *Runtime* guardrail: catches repeated/cyclic tool calls live and injects a corrective nudge. | Different problem (prevention in-flight vs retrospective coaching). No usable license — reference only. |
| **`session-report`** | official | JS / skill | **Anthropic's own session analyzer**, bundled in the official marketplace. 875-line `analyze-sessions.mjs` + HTML template: tokens, cache breaks, by-project/skill/subagent, top prompts — then the *model* writes 3–5 narrative "findings" into the page. | **Confirms the gap.** 44 token references in the script and **zero** for rework, loops, corrections, reverts or frustration. It measures spend, not habits — and its narrative is LLM-authored on the user's quota, which is the "unexplained score" pattern restated. Also our best architectural reference. |
| **Claude Code `/insights`** | — | built-in | First-party session insights. | Single-harness, not evidence-linked. |

**Two of the six differentiation claims in the design doc do not survive contact with this list:**

- **"Fully local" is not a differentiator.** vibe-log is local-first too (cloud sync is opt-in and
  sanitized), and ccusage, agentsview and the history viewer are all local. This is table stakes in
  this ecosystem, not an edge.
- **"Cross-harness" is not a differentiator.** agentsview covers 20+ agents, the history viewer 11,
  vibe-log 2. We would be starting at 1.

**The four that do survive, and should be the actual positioning:**

1. **Evidence instead of scores.** vibe-log's "prompt quality 85/100" is precisely the unexplained
   number the design doc objects to. Every finding pointing at specific turns is a real, visible,
   defensible difference.
2. **Doesn't touch the user's quota.** vibe-log runs its analysis through the user's own Claude Code
   setup, consuming their subscription. Rules-first + optional small local models means ours costs
   the user nothing to run. This is the sharpest functional distinction.
3. **Measured precision.** Nobody in this list publishes a precision number for their detections.
   The three-tier eval is the credibility moat, and it is also the hardest thing to copy.
4. **Outcome classification.** Distinguishing `convergent_iteration` and `tdd_fail_then_pass` from
   real rework is what makes a coaching claim trustworthy. No tool here attempts it.

**Timing note:** vibe-log-cli's last push was 2026-04-19 — roughly six months stale, while agentsview
and ccusage were both pushed today. The coaching niche specifically is the under-maintained one.

**Action for M0:** install and run vibe-log-cli and agentsview against the local archive, and record
in `DECISIONS.md` what each produces on real data. The differentiation argument above is built from
documentation; it needs to be checked against actual output before we commit six milestones to it.

---

---

*Extracted from the planning document (2026-10-12/15). Reasoning is kept with each
conclusion deliberately — see [DECISIONS.md](../DECISIONS.md) for the index.*
