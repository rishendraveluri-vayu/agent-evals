# Proposal: how we measure the judge and use what it says (SP5)

Status: **proposal, 4 Nov 2026 evening, for Rishi** (SP4's rubric and SP5 are **[Rishi designs]**;
nothing here is built until he approves or changes it). It answers his main concern from the guide
review: "It has to be clear where to trust [the LLM judge] or not", and "what we are struggling with
is using the output and stating how accurate it is."

## The idea in one paragraph

The judge is an instrument with an error rate, and we measure that error rate the way you would
measure any instrument: against a reference (Rishi's blind labels), **per criterion**, with
intervals. A criterion whose error is small and unbiased between arms is *trusted* and counts in
the headline; one that is not is reported but kept out. The headline itself is then **corrected for
the judge's known error**, so the result we state is "after allowing for the judge's mistakes", not
"as the judge saw it".

## 1. What we compare

- One judge verdict per (trial, rubric criterion): pass or fail, with quoted evidence.
- One label per (trial, criterion) from Rishi, in the blind labelling view (no harness, model, arm,
  cost or judge verdict shown). "Not sure" labels are kept but excluded from the agreement numbers,
  and their share is reported.
- Deterministic graders are not validated this way: they are tested against known pass and fail
  outputs instead (SP4).

## 2. The label sets (from `docs/SPEC.md` SP5)

| Set | Size | From | Used for |
| --- | --- | --- | --- |
| Tuning | about 20 | smoke trials | Tuning the rubric. Never counted in the reported agreement |
| Held-out | about 40 | pilot trials | The agreement numbers and the trust decision |
| Final | about 20 | the real experiment | Checking that agreement holds on the final model's outputs |

Sampling is **stratified**: across both arms, across tasks, and across the judge's own verdict, so
there are enough judge-passes and judge-fails to estimate both kinds of error. Order is shuffled.
Rishi relabels about 10 items at the end, blind to his first label, to measure his own consistency.

## 3. What we report per criterion

| Number | What it tells us |
| --- | --- |
| Raw agreement | Share of items where judge and Rishi agree |
| Cohen's kappa, with a 95% bootstrap interval | Agreement beyond chance. Reported with the raw numbers, because kappa drops when one answer is rare |
| Sensitivity: judge passes when Rishi passes | How often the judge recognises good work |
| Specificity: judge fails when Rishi fails | How often the judge catches bad work. Low specificity is Rishi's "bad conversations a human would not pass" worry |
| Per arm: the same four for A and for B | **Judge bias.** If the judge is more lenient on one arm, it manufactures a difference; the gap in false-pass rate between arms, with its interval, is the number that matters most |
| Test-retest: the same item judged 3 times | Share of identical verdicts; a judge that changes its mind is noise |
| Rishi's self-agreement on the relabelled items | The ceiling: no judge can agree with Rishi more than Rishi agrees with himself |

With 40 held-out labels, a kappa interval is roughly ±0.2 wide; that is the honest precision we can
claim, and the report says so.

## 4. The trust rule (D8), set before any results

A criterion is **trusted** when, on the held-out set:
- kappa is at least **0.6** and its interval's lower end at least **0.4** (D8, settled 5 Nov);
- the false-pass rate does not differ between arms (the interval for the gap includes 0);
- test-retest agreement is at least **90%**.

Otherwise it is **not trusted**: it stays in the trial view and the report, with its numbers, and is
left out of the headline pass. The numbers in brackets are Rishi's to set; once set they go into
`docs/experiment.md` before the pilot and do not move (CLAUDE.md: no tuning on held-out labels).

## 5. Using the output: the corrected estimate

The judge's measured sensitivity (Se) and specificity (Sp) let us estimate the true pass rate from
the judged one, a standard correction for a test with known error (Rogan and Gladen):

  true pass rate = (judged pass rate + Sp - 1) / (Se + Sp - 1)

We compute it per arm (with each arm's own Se and Sp if the judge is biased between arms, pooled if
not), and the A minus B difference from that. The uncertainty is a bootstrap over trials **and**
labels together, so the interval includes what we do not know about the judge.

The Compare screen and the write-up then show two lines:
- **As judged:** the difference with its interval, from the judge's verdicts.
- **Corrected for judge error:** the same, after the correction.

If the judged difference is significant but the corrected one is not, the verdict is "**not robust
to judge error**", which is exactly the case a reader needs to know about. The correction needs
Se + Sp well above 1; a criterion near 1 is untrustworthy by definition and already excluded by §4.

## 6. Rishi's four worries, as rubric and process levers

| Worry (from his notes) | Lever |
| --- | --- |
| "Bad conversations that no real human would have graded as pass" | A whole-conversation criterion, "would a real client in this situation be satisfied", validated against labels like the others; its specificity is the number to watch |
| "End goal weighted too high" | Outcome, process (right tools, right numbers) and experience (tone, clarity) criteria are scored and reported **separately**, never summed into one pass, so a right answer delivered badly shows up |
| "The persona of the judge not good enough" | The judge reads as the client's advocate and a finance professional, blind to harness and model, must quote evidence for every verdict, and is pinned (model, prompt version, settings) |
| "Cognitive load is 0 for an LLM" | A criterion that the first two sentences tell a stressed client what to do, and a word budget ("50 words?") checked as a deterministic grader, so length is measured, not judged |
| "It will tell the agent did best with what it had" | The judge sees the task's reference facts (the client file and the expected tool results), not only the transcript, so a missing calculation cannot be excused as "it worked with what it had" |

## 7. What the UI shows

- **Judge screen:** a table, one row per criterion: kappa with its interval, sensitivity,
  specificity, per-arm false-pass rates, test-retest, trusted or not and why. Plus the disagreements,
  each with the quote the judge relied on.
- **Compare screen:** next to every judged number, "trusted" or "not trusted"; the as-judged and the
  corrected difference side by side; the verdict says which one it rests on.

## 8. Cost

About $0.0034 per trial per judge pass on Gemini 3.8 Flash (D45; 3,000 input and 300 output tokens
at $0.75 / $3.75 per MTok, before any thinking tokens; an estimate until the first run measures it),
so 120 trials x 3 test-retest passes on the labelled subset is about $1.20. Sonnet 5.5 would be
about $0.009 a pass. Every judge run is signed
off with an estimate first (R8).

## Built so far (4 Nov night): the arithmetic only

`stats/` (package `evals_stats`, `evals-agreement`) computes what §3 and §5 report: per criterion
the 2x2 table, Cohen's kappa, sensitivity, specificity, false passes and false fails with
percentile bootstrap intervals; the same per arm and the false-pass gap between arms with its
interval; the Rogan-Gladen corrected rate with a joint bootstrap; test-retest stability and
Rishi's self-agreement. Each formula is pinned by a hand-worked synthetic example. No threshold
from §4 is in the code, and "not sure" labels need `--human-unsure exclude|no` every time
(decision 3). Test-retest needs every regrade's judge answers; `GET /trials/:id` shows only the
current grading, so that read is still to build.

## Decisions for Rishi

1. **Settled 5 Nov (D8):** kappa >= 0.6, lower bound >= 0.4, test-retest >= 90%.
2. Per-arm or pooled sensitivity and specificity in the correction (per-arm is safer, needs more labels).
3. **Settled 5 Nov (D46):** a "not sure" label triggers one second look, after the fresh items;
   what is still "not sure" then is excluded, and the count is reported per criterion.
4. **Settled 5 Nov (D48):** 20 tuning / 40 held-out / 20 final, as in SPEC.
5. **Settled 5 Nov (D45):** Gemini 3.8 Flash, pinned; it needs billing on the Gemini key first. (Proposed was Claude Sonnet 5.5.) For prompt v1 vs v2 both arms
   use the same model, so this is fine; in a Claude-vs-Gemini comparison a Claude judge could favour
   its own family, and the per-arm bias check in §3 is what would show it.
