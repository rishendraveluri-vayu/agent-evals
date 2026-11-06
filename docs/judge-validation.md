# Judge validation

Required by the brief: show how the judge was checked for trustworthiness, for example agreement with a small set of human-labelled examples.

**Where the judge stands (6 Nov), in one place.**

- **The candidate:** rubric v4 (`configs/rubrics/advice.v4.md`) on Gemini 3.8 Flash, frozen on 5 Nov (D74). On the 29-trial dev set its overall agreement with Rishi is kappa 0.63 (interval −0.05 to 1.00), up from 0.30 for rubric v1 on the tuning set. It has graded all 40 held-out trials (`judge-panel/d74-test-heldout-advice-v4.jsonl`); the one measurement against D8's bar waits on Rishi's blind labels of those trials.
- **What it decides today: nothing.** Every task's judge grader still runs rubric v1 and is optional (D8), so every verdict rests on the deterministic checks. If v4 passes on the held-out labels, the tasks move to v4 on Gemini 3.8 Flash as new task versions; if it does not, the judge stays visible on trial pages and uncounted.
- **Superseded on the way, kept for the record:** Phase 1's "fixed for Phase 2: Gemini 3.8 Flash with rubric v2" and D73's 27-trial labelling list, both replaced by D74 before any held-out label existed. The same 40 held-out trials were also judged once under v2 (`judge-panel/phase2-heldout-advice-v2.jsonl`, 5 Nov 19:52). That run is kept but will not be scored: rubrics v3 and v4 were written from Rishi's tuning notes and the dev set, and no held-out output was read to write them.

The main risk is not overall accuracy. It's bias that differs by config: if the judge favours long answers and one model writes longer, the result is a fake win.

## Plan (settled 5 Nov)

The full method is `docs/proposals/judge-validation.md`; the decisions are D8 (trust bar: kappa >= 0.6 with its interval's lower end >= 0.4, no false-pass gap between arms, retest >= 90%), D45 (judge: Gemini 3.8 Flash), D46 ("not sure" gets a second look), D48 (20 / 40 / 20 labels), D49 (pooled error rates), D52 (label sets follow the task split) and D68 (rubric v1 and its criteria). D7 (which judge criteria become required once trusted) stays open. The table below is the original sketch.

| Set | Size | Source | Used for |
| --- | --- | --- | --- |
| Tuning | ~20 | Smoke trials, Thu | Tuning the rubric. Not reported as agreement. |
| Held-out | ~40 | Pilot trials, Fri | Reported agreement |
| Audit | ~20 | Real experiment, Fri | Reported agreement on real outputs |
| Self-check | ~10 relabelled | From the above | Rishi's own consistency |

95% CI at 90% observed agreement, Wilson score interval:

| Labels | CI |
| --- | --- |
| 30 | 74% to 97% |
| 60 | 80% to 95% |
| 100 | 83% to 95% |

Corrected on 3 Nov. The earlier table used the normal approximation, which at 30 labels gives an upper bound of 101%. Wilson stays inside 0 to 100% and is the recommended interval at small n.

Time estimate: about 80 labels at an assumed 1.5 minutes each, about 2 hours.

## Rules

- Label blind: hide the judge's verdict and the config.
- Sample stratified across configs and likely pass or fail, not at random.
- Only Rishi writes labels. Synthetic cases stay in a separate marked set and never count as human agreement.
- Set the threshold (D8) before seeing held-out results.

## Results (5 Nov)

Judge: Gemini 3.8 Flash, rubric `configs/rubrics/advice.v1.md`, on the 33 trials of the v1 discovery run. Human: Rishi's 33 tuning labels (51 criterion labels, blind; no "not sure"). Numbers from `evals-agreement --set tuning --human-unsure exclude` and `docs/experiment.md`.

| Measure | Value |
| --- | --- |
| Agreement, tuning set, "overall" (n = 33) | kappa 0.30 (95% interval 0.00 to 0.78); sensitivity 1.00, specificity 0.20: 4 false passes, 0 false fails |
| Agreement, tuning set, specific criteria | clears-card-first 12/12, keeps-medicines 3/3, health-cover 3/3 (kappa undefined: Rishi's labels on each were all one value) |
| What the specific criteria caught that "overall" missed | `clarifies-ambiguous-amount` said no on 3 of 3 payoff-order trials Rishi failed for assuming what ₹20,000 meant; `explains-plainly` said no on the FD answer he called confusing |
| Test-retest (the same 33 outputs judged twice) | 98 of 99 verdicts repeated (99.0%); clarifies-ambiguous-amount 5/6 (83%), every other criterion 100% |
| Held-out agreement (40 labels) | **not run**: no held-out labels yet |
| Per-arm false-pass gap | not measurable without held-out labels on both arms |
| Rishi's self-consistency | not run (no relabels) |

What this means: no judge criterion has met the trust bar, because the bar is measured on held-out labels, which do not exist yet. So **no judge criterion counts in the headline pass rate**; the headline rests on the required deterministic checks only, and the judge's verdicts are shown in each trial and reported, never gated. On the tuning set the specific criteria agree with Rishi where measurable and the whole-conversation "overall" criterion is lenient, which is why criteria are scored separately (D69 kept rubric v1 unchanged rather than tune it mid-experiment).

## The judge panel (D71), set out before it runs (5 Nov)

Rishi: "Do multiple models labels on them and find which disagree and iterate, ideally should be same as me reviewing." Three judges read the same trials with the same rubric: Gemini 3.8 Flash (the current judge, a different family from the agent), Claude Sonnet 5.5 and Claude Haiku 5.5 (the agent's family, so they may favour its answers). Each runs through the offline grader (`evals-grade --judge-model`) on the recorded trial folders, with one LiteLLM key capped at $8 for the whole panel.

**Phase 1: tune, on the discovery set only.** The judges grade the 33 discovery trials Rishi labelled (`labels/tuning.jsonl`). For each judge and criterion: agreement with Rishi (kappa, sensitivity, specificity), and every trial where a judge disagrees with him or with another judge, with its quote and reason. The rubric may be revised where they go wrong (as `configs/rubrics/advice.v2.md`), and the panel re-run, up to 3 rounds. Phase 1 ends by fixing, from these results only: the rubric, and which judge counts (one model, or the majority of the three).

**Phase 2: measure once, on held-out trials, rubric frozen.** The judges grade 40 trials of the headline run, 20 per arm, 2 per held-out task and arm, picked at random with a fixed seed before any judge sees them. Rishi labels, blind, every trial where the judges disagree on a criterion, plus 10 picked at random from those where all three agree. Agreement is then estimated over all 40 with each labelled trial weighted by how likely it was to be picked (the agreed trials stand for all the agreed ones), and reported per criterion for the chosen judge against D8's bar, and for the other two as context. The other judges' results do not change the choice: picking the best of three on the same held-out labels would flatter the winner. If no criterion clears the bar, the judge still counts for nothing, and that is the result.

**Amended before any held-out label was written (D73, 5 Nov; its 27-trial list was superseded by D74, which labels all 40):** the platform takes more than one rater. If other raters can label (Rishi named two possible; they are remote, so it waits on an offline labelling page, in the spec's parking lot), each labels the same 27 trials, blind to the judges and to each other (each has their own queue, `#/labels?set=heldout&items=...`, with their rater id). The reference is the raters' majority on each criterion (a tie is left out); agreement with each rater is reported too. The raters' agreement with each other (pairwise Cohen's kappa on the items they share) is reported beside the judge's as the ceiling a judge can be expected to reach. With Rishi alone, the reference is his labels, as before. D8's bar is unchanged. `evals-panel judge-panel/phase2-heldout-advice-v2.jsonl --labels labels/heldout.jsonl --weights judge-panel/phase2-to-label.json` computes all of it.

**What would change it.** A judge that cannot read the recorded trials (an `error` grade) is reported, not dropped. Spend beyond the cap stops the panel; what has run is reported.

### Amended before any held-out label (D74, 5 Nov): the judge learns how Rishi judges

Following "critique shadowing" (Husain: the expert's pass/fail plus a written critique, a few of them as worked examples in the judge prompt, the prompt revised on a dev set, then frozen and measured once on a hidden test set), rubric v3 (`configs/rubrics/advice.v3.md`) adds to v2 the six principles in Rishi's tuning notes, quoted, and four of his tuning trials as worked examples with his verdict and critique (payoff-order no, fd-real-value no, emi-home-loan yes, car-loan-afford yes). The split: **train** = those four trials (in the prompt); **dev** = the other 29 tuning trials (the judges run on these, at most 2 rounds); **test** = all 40 sampled held-out trials, which Rishi labels with a one-line why on each, and the frozen judge is measured on once. Labelling all 40 replaces "the disagreements plus 10 agreed": the test set no longer depends on which trials the judges disagreed on, so no weighting is needed. The judge that counts stays Gemini 3.8 Flash; the other two are context. Only 5 of the 33 tuning trials are fails and Rishi wrote a note on 6, so the dev results will have wide intervals.

### D74 results on the dev set (5 Nov; 29 tuning trials, 3 of them fails)

| "overall" against Rishi, dev set | v2 kappa | v3 kappa | v4 kappa (95% interval), specificity, false fails |
| --- | --- | --- | --- |
| Gemini 3.8 Flash (the judge that counts) | 0.47 | 0.51 | **0.63** (−0.05 to 1.00), 0.67, 1 |
| Claude Haiku 5.5 | 0.25 | 0.25 | 0.53 (0.00 to 0.89), 1.00, 4 |
| Claude Sonnet 5.5 | 0.01 | 0.21 | 0.46 (0.00 to 0.79), 1.00, 5 |
| Majority of the three | 0.06 | 0.30 | 0.53 (0.00 to 0.89), 1.00, 4 |

- **v3** (his principles and worked examples) let Gemini catch more of his fails (specificity 0.33 to 0.67) but added two false fails. One applied principle 5 ("look for a cheaper way out") as a reason for a no, where his own verdicts treat it as an aside; the other failed an arithmetic slip he passed.
- **v4** says which principles he fails an answer for (an unasked assumption, a confusing explanation) and which only make a better answer, read from his verdicts. Every judge improved.
- **Frozen: rubric v4, judge Gemini 3.8 Flash**, after the two rounds the plan allows. On the dev set Gemini's kappa clears D8's 0.6 as a point estimate, with a lower bound far below 0.4, so nothing is trusted until the held-out test.
- One Gemini call in round 2 ran out of output (the reply was cut off at 8,000 tokens on a long conversation): an `error`, reported, not counted. Spend at that point $4.55 of the panel's $8; $5.89 in all once the D74 rounds and the held-out judging ran (`docs/cost.md`).

### Phase 1 results (5 Nov, discovery trials only)

Data: `judge-panel/phase1-round1-advice-v1.jsonl` and `judge-panel/phase1-round2-advice-v2.jsonl` (one row per trial, judge and criterion; `scripts/judge_panel.py`), compared with `evals-panel` (`stats/`). Spend $1.66 for the two rounds (198 judge calls).

| "overall" against Rishi (n = 33) | Rubric v1: kappa, specificity | Rubric v2: kappa (95% interval), specificity, false fails |
| --- | --- | --- |
| Gemini 3.8 Flash | 0.30, 0.20 | 0.53 (0.00 to 1.00), 0.40, 0 |
| Claude Haiku 5.5 | 0.06, 0.20 | 0.42 (0.03 to 0.74), 0.80, 6 |
| Claude Sonnet 5.5 | 0.02, 0.20 | 0.21 (−0.11 to 0.54), 0.60, 8 |
| Majority of the three | 0.06, 0.20 | 0.29 (−0.08 to 0.64), 0.60, 6 |

On the specific criteria (clears-card-first 12, keeps-medicines 3, health-cover 3) every judge matched Rishi in both rounds, except Haiku on one keeps-medicines in round 2.

- **Round 1 (rubric v1):** all three judges passed the same four trials Rishi failed, three of them draft-payoff-order, where he wrote "is the 20k beyond the minimum payments or 20k is the total she puts ... first clarify before assuming". The Claude judges noticed ("the ₹20,000 interpretation is never flagged") and passed anyway. Their errors are shared, so a majority cannot correct them.
- **Rubric v2** (`configs/rubrics/advice.v2.md`) adds one rule from those notes: an answer resting on an unflagged assumption about a fact that changes the advice is a no on any criterion about whether the client was served.
- **The Claude judges fail trials Rishi passed,** mostly on arithmetic the rubric tells them not to redo: "₹13,800" where the tool gives about ₹6,664, "₹25,700" where it is ₹25,099.25. These are real slips in the answers; whether they should fail "overall" is Rishi's to say on review, so the rubric was not tuned to silence them.
- **Stopped after two rounds:** Rishi failed 5 of the 33 tuning trials, so a third round would fit those few trials rather than the rule.

**Fixed for Phase 2 (superseded by D74 the same evening, before any held-out label; see the top of this file):** the judge that counts is **Gemini 3.8 Flash with rubric v2**: the highest agreement in both rounds, no false fails, and from a different family than the agent. The majority is reported in Phase 2 as context only. On the tuning set it is still below D8's bar (kappa 0.53, lower bound 0.00), and the bar is measured on held-out labels.

## Limits to state

- Single human rater.
- Small label set, so wide intervals.
- The tuning labels come from the agent's own v1 discovery run on the same model as the experiment (Claude Haiku 5.5), not a cheaper one.
- The judge (Gemini) is from a different family than the agent (Claude), so self-preference cannot tilt a Claude-vs-Claude comparison; it could in a Gemini-agent comparison.
