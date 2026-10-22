
---

## The rubric widening, and the per-session verdict (2026-10-21)

Both buried with evidence. Both had a good argument behind them and both made
the judge worse, which is why they are written down rather than forgotten.

### What was tried

The judge found 35 of 58 sessions holding a human-validated problem. Five
hypotheses for the gap had already been eliminated by measurement — packet
fidelity (no change), model capability (Sonnet worse at 18x cost), turn
anchoring (a real bug, +4 points, fixed), attention dilution from batching
(0 omissions when a verdict was required), and evidence absent from the packet
(99% present). That left the rubric, and the rubric looked guilty:

```
  inaccurate_self_report   10/25   40%   no source or push-back restriction
  misread_intent           12/46   26%   required developer push-back
  constraint_violation     11/81   14%   constraint had to be in a PROMPT
  overreach                 0/13    0%   required push-back, never scored once
```

Fifteen false negatives were read by hand. Their evidence was in the packet, and
several were constraints stated in a *skill file* — which the rubric explicitly
put out of bounds. So: un-restrict the source, and demote push-back from a
requirement to evidence.

### What happened

```
                            session      episode      claim     false pos
flat list + narrow rubric   35/58  60%   56/127 44%   33/165 20%    13
verdicts  + wide rubric     35/58  60%   47/127 37%   25/165 15%    19
verdicts  + narrow rubric   25/58  43%   35/127 28%   21/165 13%     -
verdicts  + light suppress  24/58  41%   38/127 30%   21/165 13%     -
```

**Worse on both axes.** Recall down, false positives up 13 -> 19.

The widened rubric turned `overreach` into a dumping ground: 2 findings -> 16,
of which **1** matched a labelled overreach. Without "and the developer pushed
back", *"did substantial work beyond what was asked"* describes an agent working
thoroughly. Push-back was not an arbitrary restriction; it was the thing that
made the dimension mean anything.

Removing those 16 findings from the score made it *worse* (47 -> 43 episodes),
so the dumping ground was not even the main cost — they were landing in roughly
the right places, just mislabelled.

### The methodology failure, which is the more useful lesson

The first run changed **two things at once**: the rubric and the response
contract. The contract was argued to be recall-neutral on the strength of a
10-batch test — run under the *old* rubric. Isolating it afterwards:

**the per-session verdict contract alone costs 17 points of session recall.**
The rubric widening had been masking it. Two mistakes cancelling looked like one
neutral result.

A follow-up blamed the wording — one per-packet suppression line had become a
per-session one, so the model applied "say nothing" 2-3 times per batch instead
of once. Lightening it back to a single statement: **41%**. The wording was not
it either. The contract is simply harmful.

### What was kept

Nothing from the rubric change. The anchor fix shipped separately and stands on
its own (+4 points, and it fixed a user-facing bug where 45 of 87 findings
pointed a median 460 turns from their evidence).

### The finding that outlives both

**Recall swings 43% -> 60% on where one sentence sits in the prompt.** The 60%
baseline is therefore partly an artifact of suppression dosage rather than a
stable property of the judge, and every conclusion drawn from a single run at a
single dosage inherits that instability. Any future rubric work needs a variance
estimate across runs before a 9-episode difference is called a result.

---

## The measurement itself, measured (2026-10-21)

Not a buried detector — a buried **method**. Every single-run comparison in this
project before this date is unreliable, and this entry exists so nobody repeats
the mistake by trusting a number in an older commit message.

### Three runs of identical code

Same 60 gold sessions, same Haiku model, same prompt, no code change between
them. 35 calls each, zero failures, zero gate refusals:

```
           run1  run2  run3    spread    mean
  session    52%   66%   67%     16 pts     61%
  episode    36%   47%   50%     13 pts     44%
  claim      15%   19%   21%      6 pts     18%
```

**16 points of spread on the headline metric, from sampling alone.**

### What it invalidates

Four conclusions drawn earlier the same day, each from a single run:

| conclusion | measured as | with the band known |
|---|---|---|
| widening the rubric is neutral | 60% -> 60% | unknown; both inside 52-67% |
| the per-session verdict costs 17 points | 60% -> 43% | 43% is below the band, so probably real, but not 17 |
| lighter suppression wording did not help | 43% -> 41% | indistinguishable |
| Sonnet is worse than Haiku | 27 vs 18 claims | **holds** — claim-level spread is only 6 points |

The anchor fix survives untouched because it was re-scored **from cache**: same
findings, no model call, so 16% -> 20% claim-level is arithmetic rather than
sampling.

### The awkward part

**Claim-level is the most stable metric (6 points) and the least
product-relevant. Session-level is the right unit for a tool that surfaces one
thing to try, and the least stable (16 points).** There is no version of this
where the number we care about is the number we can measure cheaply.

### Correction: most of that spread was a sample size I chose

The entry above was written as though 16 points were a property of LLM judging.
It is mostly a property of **n = 58**, and the sample was 58 because an early
cost decision picked `60` and a dozen runs inherited it without anyone asking.

Sitting on the same disk the whole time:

```
  transcripts locally                1,140
    with published POSITIVE labels     246   <- we used 60
    labelled NEGATIVE (clean)          319   <- we used 60
  claims across all 246                557   <- we scored against 165
```

Standard error falls as 1/sqrt(n), so reading the whole set buys the same
precision as repeating the run, and raises the claim count at the same time:

```
  strategy                      sessions   cost     SE of result
  1 run  x 60   (all day)            58    $0.58    +/- 8.4 pts
  3 runs x 60   (first proposal)     58    $1.74    +/- 4.8 pts
  1 run  x 246  (whole gold set)    246    $2.46    +/- 4.1 pts
  2 runs x 246                      246    $4.92    +/- 2.9 pts
```

**One pass over the full set beats three over a quarter of it** — tighter, one
wall-clock run instead of three, and 557 claims instead of 165.

### The rule this leaves behind

- **Use the whole labelled set.** It is local, it costs ~$2.46, and sampling it
  was never a decision anyone made on purpose.
- **No conclusion from a single run on a subset.** At +/- 4.1 pts on the full
  set, an 8-point improvement is detectable — about the size worth shipping.
  Add a second run when a result lands near the boundary.
- A deterministic re-score from a cached run costs nothing and has **zero**
  variance. Prefer it wherever the change is to scoring or derivation rather
  than to the prompt — it is why the quote-anchor fix is the one result from
  this day that stands without an error bar.
- Claim-level remains the most stable metric and the least product-relevant;
  session-level the reverse. On the full set both tighten, which is the real
  argument for reading all of it.
