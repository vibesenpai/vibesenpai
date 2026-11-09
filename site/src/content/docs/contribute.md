---
title: Contribute
description: How to set up, what the rules are, and what is reproducible without a 47 GB download.
---

This page covers setting up the repository, the checks a change must pass, the
rules the code holds to, and how to add a detector.

## How do I set it up?

```bash
git clone https://github.com/vibesenpai/vibesenpai && cd vibesenpai
npm install
npm test                 # the whole suite, no network
npm run cli -- insights  # against your own sessions
```

Node 22.13 or later. There are no runtime dependencies, and a change that adds
one needs a reason.

## What must pass?

```bash
npm run typecheck        # strict, with noUnusedLocals
npm run lint             # knip: no unused files, exports or dependencies
npm test
npm run test:pane        # the pane, through Claude Code's plugin test runner
npm run verify:corpus    # fetches two small MIT corpora; fails on count drift
```

`verify:corpus` re-runs the parser and detectors over pinned public transcripts
and fails if any published count moves. When you change a detector, it shows
what changed.

## What can I reproduce?

| needs | reproduces |
|---|---|
| nothing extra | the test suite, and `verify:corpus`, which fetches two small MIT-licensed transcript corpora itself |
| a 47 GB gated dataset and a Hugging Face login | `npm run gold` and `npm run judge:control`, which score the judge against the labelled set from [arXiv 2605.29442](https://arxiv.org/abs/2605.29442) |

So the judge's accuracy figures need that download to reproduce.

## What rules does the code hold to?

- **Measure before you build.** A new dimension needs a frequency from real
  sessions. The [graveyard](/vibesenpai/work/graveyard/) lists detectors that
  were removed once measured.
- **A detector cannot read text.** `StructuralEvent` omits the text fields, so
  reading text in a detector is a compile error.
  [The two tiers](/vibesenpai/architecture/two-tiers/)
- **Never copy raw harness data.** Transcripts are read in place, and what is
  derived is redacted as it is built.
- **Never write a project file or your config.** Apply in the pane drafts
  a request into Claude Code's prompt box; your Enter is the yes, and
  the agent makes the change under Claude Code's own permission prompt. Every
  request ends with `(vibesenpai fix <id>)`. A fix counts as applied only when
  that marker is seen in a session, never because a button was pressed.
- **A broken analyzer must never break a session.** Every hook exits 0
  whatever happens.
- **No number a user cannot check.** Every published frequency comes from
  `npm run measure`. Spend is recorded in tokens and in the dollar figure
  Claude Code itself reports.

## How do I add a detector?

1. Measure its frequency with `npm run measure`.
2. Write it against `StructuralEvent` in `src/detect/`.
3. Add a synthetic fixture *and* a healthy look-alike that must not fire.
4. Run `verify:corpus` and update `scripts/corpus.json` with the new counts.
5. Read its findings on real sessions.

Step 5 is required. Three detectors once passed every test and were still
mostly wrong on real sessions ([How it was measured](/vibesenpai/architecture/measurements/#the-graveyard)).

## How is a release made?

Set the same version in `package.json` and `.claude-plugin/plugin.json`, then
push a tag `v<version>`. The release workflow runs the tests, checks the tag
matches both files, builds the zip, attaches it to a GitHub release, and points
`marketplace.json` at it by `sha256`.
[Releases and install counts](/vibesenpai/architecture/releases/)

Then check the release from the outside, on your own machine:

```sh
npm run validate:release -- <version>            # the published files, then a real install
npm run validate:release -- <version> --spend    # also the model reads
```

It installs into a separate Claude Code profile (`CLAUDE_CONFIG_DIR`), so your own setup is not
touched; log in to that profile once the first time. Without `--spend` it still runs one short
`claude -p` turn on that account. It does not run in CI, because it needs an account.
