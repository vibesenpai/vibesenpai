# Contributing

```bash
git clone https://github.com/vibesenpai/vibesenpai && cd vibesenpai
npm install
npm test                 # the whole suite, no network
npm run cli -- now       # run it against your own sessions
```

Node 22.13+. **Zero runtime dependencies** — that is a constraint rather than an
accident, and a change that adds one needs an argument in the PR.

## The gates

```bash
npm run typecheck        # strict, plus noUnusedLocals / noUnusedParameters
npm run lint             # knip: no unused files, exports or dependencies
npm test
npm run verify:corpus    # fetches two small MIT corpora; fails on count drift
```

`verify:corpus` is the one that catches real regressions. It re-runs the parser
and detectors over pinned public transcripts and fails if any published number
moves. If you change a detector, this is what tells you what you changed.

## What is reproducible, and what is not

**Without any download:** the test suite, and `verify:corpus`, which fetches its
own corpora.

**Needs a ~47 GB gated dataset:** `npm run gold` and `npm run judge:control`,
which score the judge against the labelled set from
[arXiv 2605.29442](https://arxiv.org/abs/2605.29442). It needs a Hugging Face
login. So the judge's accuracy figures are **not** reproducible by a casual
contributor, and we would rather say that than imply otherwise.

## Rules this project holds

**Measure before you build.** Ten detectors are in [`GRAVEYARD.md`](GRAVEYARD.md)
because they were measured. A new dimension needs a frequency from real
sessions, not an intuition.

**A detector cannot read text.** `StructuralEvent` omits the prose fields, so
reading text inside a detector is a compile error. This is deliberate:
text-based heuristics are how the first three detectors died.

**Never copy raw harness data.** Transcripts are read in place; the derived form
is redacted at construction, never after.

**Never write the user's config without consent.** Every write prints the change
and requires `--apply`.

**Principle Zero: a broken analyzer must never break a session.** Every entry
point exits 0 whatever happens.

**No number a user cannot verify.** Tokens, never dollars — a price depends on
plan and tier, and on a subscription it is notional.

## Adding a detector

1. Measure the frequency over the pinned corpus: `npm run measure`
2. Write it against `StructuralEvent` in `src/detect/`
3. Add a synthetic fixture **and** a healthy look-alike that must not fire
4. Run `verify:corpus`, and update `scripts/corpus.json` with the new counts
5. **Read the findings on real data**

Step 5 is not optional. Three detectors passed every test and then produced 19
false positives and 0 true positives on real sessions. It is the only check that
has ever caught anything here.

## Commits and PRs

Explain *why*, with the number that motivated it. The commit log is part of how
this project records what it learned — see `git log` for the register.

If you delete something, add it to [`GRAVEYARD.md`](GRAVEYARD.md) with the
evidence. A verdict without its evidence guarantees the decision gets
re-litigated.
