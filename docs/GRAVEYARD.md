
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
