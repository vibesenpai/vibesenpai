# Distribution & packaging

### Where the plugin gets published

The Anthropic **official/partner** marketplace is deliberately **not** the plan. It requires partner
approval against "quality and security standards", and it is not where most of the ecosystem lives
anyway. Verified on 2026-10-13:

| Tier | What it is | Gatekeeper | Discovery value |
|---|---|---|---|
| **1 · Self-hosted** | our own repo with `.claude-plugin/marketplace.json` | **none** | users must know the repo name |
| **2 · Anthropic *community* marketplace** | [`anthropics/claude-plugins-community`](https://github.com/anthropics/claude-plugins-community) — a distinct repo from the official one | **automated security scan**, not partnership | **high** — appears in `/plugin` Discover search for everyone who has added it |
| **3 · Curated lists & directories** | awesome-lists, web directories, GitHub topic | a PR, or nothing | moderate, cumulative |
| **4 · Third-party marketplaces** | AgentStore, Protonium, `ykdojo/claude-code-tips` | varies | niche |
| ~~Official/partner~~ | `claude-plugins-official` | partner approval | **not pursued** |

**Tier 2 is the important correction.** `anthropics/claude-plugins-community` is a separate
marketplace from the official one, carrying third-party plugins that passed **automated security
scanning** — not a partnership review. It is a read-only nightly mirror of Anthropic's review
pipeline (direct PRs are auto-closed; everything flows through the submission form). Added manually:

```
/plugin marketplace add anthropics/claude-plugins-community
/plugin install agentsensei@claude-community
```

That is the realistic distribution target: a security screen rather than a business relationship, and
it puts the plugin in the in-product `/plugin` Discover search for anyone who has added the community
marketplace — which is the single biggest discovery lever available without being a partner.

**Tier 1 ships first regardless**, because it has no gatekeeper and works the day the repo is public:

> **Note on the namespace.** The repo lives at `crozzfire/agentsensei`, so the marketplace path is
> `crozzfire/agentsensei`. The **plugin name stays `agentsensei`**, so commands remain
> `/agentsensei:*` — marketplace path and plugin name are independent. If this later moves to an
> `agentsensei` org, `marketplace.json`'s top-level `renames` key handles the move without breaking
> existing installs.

```
/plugin marketplace add crozzfire/agentsensei
/plugin install agentsensei
```

**Tier 3 is cheap and worth doing all of it** — these are PRs or form submissions, not negotiations:

- [`ccplugins/awesome-claude-code-plugins`](https://github.com/ccplugins/awesome-claude-code-plugins)
  — 100+ plugins, 20+ categories, and explicitly invites *"submit your own marketplace"*
- [`composio-community/awesome-claude-plugins`](https://github.com/composio-community/awesome-claude-plugins)
  and [`Chat2AnyLLM/awesome-claude-plugins`](https://github.com/Chat2AnyLLM/awesome-claude-plugins)
- [`jmanhype/awesome-claude-code`](https://github.com/jmanhype/awesome-claude-code),
  [`jqueryscript/awesome-claude-code`](https://github.com/jqueryscript/awesome-claude-code)
- [`ihistand/marketplace`](https://github.com/ihistand/marketplace) — a curated third-party marketplace
- [`claudemarketplaces.com`](https://claudemarketplaces.com/) — browser directory with install counts
- the [`claude-code-plugins`](https://github.com/topics/claude-code-plugins) GitHub topic, which is
  itself a discovery surface and costs one line of repo metadata

**Order of operations:** self-host → tag a release → awesome-list PRs and the GitHub topic → submit to
the community marketplace once precision is measured. Nothing blocks on review, and the community
submission is far stronger backed by a working tool with an `eval` number than by a plan.

Two mechanics worth copying from the 262 third-party entries in the official marketplace, since the
community one uses the same schema: **releases must be tagged and immutable** (they pin `ref` + `sha`),
and `marketplace.json` supports a top-level `renames` key — which handles plugin renames without
breaking existing installs, notably relevant given how much this one's name moved.

### Reference implementations — how local-first plugins with a download step actually do it

Read from the plugins installed on this machine, 2026-10-13. Three patterns exist, in increasing
order of helpfulness, and the third is a near-exact precedent for our problem.

**Pattern A — punt to the user.** All twelve official `*-lsp` plugins (`typescript-lsp`,
`rust-analyzer-lsp`, `pyright-lsp`, …) ship **only a LICENSE and a README**. The README says
*"Install the TypeScript language server globally via npm."* Zero code, zero bootstrap, and the
dependency is the user's problem. Honest and maintenance-free; poor experience. This is the baseline
we are choosing to beat.

**Pattern B — let a package manager fetch on demand.** `serena` and `playwright` ship nothing but a
`.mcp.json`:

```jsonc
// serena
{ "serena": { "command": "uvx",
              "args": ["--from", "git+https://github.com/oraios/serena", "serena", "start-mcp-server"] } }
// playwright
{ "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] } }
```

`uvx`/`npx` handle download and caching invisibly. Elegant, but it is a network dependency on every
cold start and gives no control over progress reporting or failure messaging. Not suitable for a
270 MB model set.

**Pattern C — explicit bootstrap, and this is the one to copy.** `mem0`'s
`scripts/ensure_deps.sh` installs a **110 MB** Python venv and is the closest existing analogue to our
download. Its mechanics, all of which we adopt:

| Mechanism | What mem0 does | Why we need it |
|---|---|---|
| **`$CLAUDE_PLUGIN_DATA`** | persistent per-plugin data dir, provided by Claude Code (`~/.claude/plugins/data/<plugin>-<marketplace>/`), with a fallback if unset | **this is where the 270 MB goes** — sanctioned, and removed on plugin uninstall |
| **`$CLAUDE_PLUGIN_ROOT`** | the plugin's own install directory | locating bundled scripts and the manifest |
| **Stamp file** | copies `requirements.txt` into the data dir; reinstalls only when it differs | exactly our model-version invalidation: a `models.json` manifest with versions + checksums as the stamp |
| **`mkdir` lock directory** | atomic lock; a second process waits up to 60s and reads a failure sentinel | **the bug the first design missed — see below** |
| **`.install-failed` sentinel** | records failure so other processes and later runs can report it | legible failure across sessions |
| **`exit 0` on failure** | writes one line to stderr and exits clean | Principle Zero: never break a session |

**The bug this caught: concurrent sessions.** Nothing in this plan accounted for two Claude Code
sessions starting at once. Without a lock, both would begin downloading 270 MB into the same
directory — doubling bandwidth, racing on the same files, and plausibly leaving a corrupt model that
passes a naive existence check. mem0 solves it with `mkdir` as an atomic lock plus a bounded wait, and
we take the same approach: **lock before download, second process waits and reports, never downloads
twice.**

**Where we deliberately differ from mem0: it bootstraps *inside* the `SessionStart` hook; we must
not.** mem0 is right for mem0 — its plugin is useless without the SDK, so blocking SessionStart for a
one-time install is the correct trade. Ours is the opposite: **every `core` dimension works with no
models at all**, so a session-blocking 270 MB download would buy nothing and cost everything. The
models are therefore downloaded only by a user-initiated foreground action, while the hook stays
a sub-10ms no-op that checks a stamp file and moves on.

**Storage split, which the plugin data dir makes obvious:**

| What | Where | Why |
|---|---|---|
| **Store** (catalog + findings, SQLite — **no transcript copies**) | `$XDG_DATA_HOME/agentsensei` | durable derived data. Must **survive plugin uninstall** and be shared with the CLI — two stores would mean two different answers |
| **Classifiers** (~270 MB) | `$CLAUDE_PLUGIN_DATA` when running as a plugin, else XDG | large, disposable, re-downloadable, and correctly removed when the plugin is uninstalled |

That split is the right default precisely because the consequences of losing each are different:
losing the store loses irreplaceable derived history; losing the models costs a re-download.

### The install-time offer

Asking at install is better than asking at first report, because the user is already in a
decision-making frame and expects setup questions. Two options:

```
  agentsensei installed.

  34 sessions found in ~/.claude/projects — ready to analyse with no further setup.

  Multiple more dimensions can be measured with semantic analysis, such as
  paraphrase-aware constraint matching, contradiction detection, and prompt
  quality scoring.

  One-time 270 MB download. Runs entirely on your machine: no LLM, no API key,
  no account, nothing sent anywhere.

    1  Download now
    2  Later — run /agentsensei:setup-models any time
```

**No hard count in the copy.** "6 more dimensions" would go stale the moment a dimension is added,
removed, or gated behind `eval` — and it implies a precision the catalogue does not have. *"Multiple
more dimensions, such as…"* names the capabilities instead, which is what the user is actually
deciding about.

**One mechanical constraint shapes how this is built: the hook cannot do the download.** Principle
Zero and the hook rules forbid it — a `SessionStart` hook pulling 270 MB would block a session or fail
invisibly. So the flow is:

1. `userConfig` in the plugin manifest optionally captures the preference at install time (a verified
   plugin.json field, used by mem0).
2. The first `SessionStart` hook **emits the offer** — it writes text, not bytes.
3. If the user picks option 1, **the model runs `agentsensei models install` as a foreground tool
   call** in the conversation. Progress is visible, failure is legible, and nothing happens in a
   background process nobody is watching.

That keeps "hooks never download" intact while still giving the choice at install time. The offer is
shown **once**; the answer is remembered either way, and `/agentsensei:setup-models` remains the
path back for anyone who deferred.

**Naming — the artifact and the capability get different names, on purpose.**

- **Artifact: "models."** Accurate and future-proof. "Classifiers" was considered and rejected because
  it mislabels the largest component: of the 270 MB, **175 MB is EmbeddingGemma, which classifies
  nothing** — it is an embedding model. Only the NLI cross-encoder and the SetFit heads are
  classifiers. "Models" also survives adding a reranker or any other model type later. Used in config
  keys, paths, `doctor` output, and the command: `/agentsensei:setup-models`,
  `agentsensei models install`.
- **Capability: "semantic analysis."** This is the real and explainable line: the rules tier is
  **structural** (did a command run, was a test executed, did files change), the model tier is
  **semantic** (is this a paraphrase, does this contradict, is this prompt specific enough). It is
  what the user needs to understand at the decision point.

The worry that "models" implies an LLM dependency is real but belongs in the copy, not the noun — one
clause ("no LLM, no API key, nothing sent anywhere") settles it, and that clause has to be there
regardless.

---

*Extracted from the planning document (2026-10-12/15). Reasoning is kept with each
conclusion deliberately — see [DECISIONS.md](../DECISIONS.md) for the index.*
