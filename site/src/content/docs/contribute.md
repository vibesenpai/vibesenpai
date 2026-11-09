---
title: Contribute
description: How to set up, what the rules are, and what is reproducible without a 47GB download.
---

```bash
git clone https://github.com/vibesenpai/vibesenpai && cd vibesenpai
npm install
npm test                 # the whole suite, no network
npm run cli -- insights  # against your own sessions
```

Node 22.13+. Zero runtime dependencies — that is a constraint, not an accident,
and a PR that adds one needs an argument.

## The gates

```bash
npm run typecheck        # strict, with noUnusedLocals
npm test
npm run test:pane        # the pane, through Claude Code's plugin test runner
npm run verify:corpus    # fetches two small MIT corpora; fails on count drift
```

`verify:corpus` is the one that catches real regressions. It re-runs the parser
and detectors over pinned public transcripts and fails if any published number
moves. If you change a detector, this is what tells you what you changed.

## What is reproducible, and what is not

Being straight about this because the docs used to claim more than was true.

**Without any download:** the test suite, and `verify:corpus`, which fetches two
small MIT-licensed transcript corpora itself.

**Needs a 47 GB gated dataset:** `npm run gold` and `npm run judge:control`,
which score the judge against the labelled set from
[arXiv 2605.29442](https://arxiv.org/abs/2605.29442). It requires a Hugging Face
login. So the judge's accuracy figures are not reproducible by a casual
contributor, and saying otherwise would be false.

## Rules this project holds

**Measure before you build.** Ten detectors are in the graveyard because they
were measured. A PR adding a dimension needs a frequency from real sessions, not
an intuition.

**A detector cannot read text.** `StructuralEvent` omits the prose fields, so
reading text in a detector is a compile error. This is deliberate: text-based
heuristics are how the first three detectors died.

**Never copy raw harness data.** Transcripts are read in place and the derived
form is redacted at construction, never after.

**Never write a project file or the user's config.** A fix is applied from the
pane: Apply drafts a request into Claude Code's prompt box, and the developer's
Enter is the yes. The agent then makes the change under Claude Code's own
permission prompt. Every request ends with a marker,
`(vibesenpai fix <id>)`, and a fix counts as applied only when that marker is
seen in a session, never because a button was pressed.

**Principle Zero: a broken analyzer must never break a session.** Every entry
point exits 0 whatever happens.

**No number a user cannot verify.** Every published frequency comes from
`npm run measure` over the pinned corpus. Spend is recorded in tokens and in the
dollar figure Claude Code itself reports, never a figure of ours.

## Adding a detector

1. Measure the frequency over the pinned corpus with `npm run measure`
2. Write it against `StructuralEvent` in `src/detect/`
3. Add a synthetic fixture *and* a healthy look-alike that must not fire
4. Run `verify:corpus` and update `scripts/corpus.json` with the new counts
5. Read the findings on real data — this is the check that has caught everything

Step 5 is not optional. Three detectors passed every test and produced 19 false
positives and 0 true positives on real sessions.

## Releasing

Set the same version in `package.json` and `.claude-plugin/plugin.json`, then
push a tag `v<version>`. The release workflow runs the tests, checks the tag
matches both files, builds the zip, attaches it to a GitHub release, and points
`marketplace.json` at it by `sha256`.
[Releases and install counts →](/vibesenpai/architecture/releases/)
