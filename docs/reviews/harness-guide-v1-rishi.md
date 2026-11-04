# Rishi's review of harness guide v1 (4 Nov 2026), and what we do about it

Transcribed from 28 photographed pages of handwritten notes. My reading is in plain text; the
quotes are his words. Where I read a word uncertainly it is marked [?].

## The notes, in order

| # | Where | Note |
| --- | --- | --- |
| 1 | §1 summary | "Cross agent runs are complicated, we need to be clear about this. If they want to see same prompt with Hermes vs LangGraph, makes for superb functionality but port everything." |
| 2 | Table 1b | "Tool calls must be standardized, we cannot fail at those. Assuming these agents run well on their own, so our MCP or adapter must be the issue." |
| 3 | Table 1b | "Other failure states also, basically a failed config should not break the test. So we need to be super smart about this. Assume they will know Hermes in and out and would be a key test for us." |
| 4 | Table 1b | "Main thing is being upfront and clear about it: so if they input bad config we must pick that and state upfront. And help them fix it. i.e. a temp setting is meaningless with Haiku 5.5, so any new run with a temp change is no value and bad spend. We must highlight this." |
| 5 | §2 | "Multiple trials on same data need to support." |
| 6 | §2.1 | "Is a trial standalone? Linking it to other trials may be useful." |
| 7 | §2.1 | "We rarely run a one-off instance; we change compared to a run." |
| 8 | §2.2 settings | "May not work for each harness." |
| 9 | §2.2 end states | "How do we show new agent consumes fewer tokens? Useful." |
| 10 | §2 | "I am looking at how a team would use this. We take a trial, change slightly, re-run, compare: source trial, or parent trial." |
| 11 | §2 | "Ability to run parallel trials. The spec says A vs B, is it really necessary. Worth thinking: we allow say A vs B vs C vs D." |
| 12 | §2 | "The logging and version control has to be spot on." |
| 13 | §2.3 | "Rethink, pause, continue, stop. Compare at [milestones?]." |
| 14 | §2.3 | "Trial, maybe like a machine learning process: if the loss is too high we don't need to spend. Similarly, we may need a threshold beyond which it stops. It's an intelligent feature worth a thing. Pause, review, continue, stop etc would be great." |
| 15 | §2.4 | "Does this have conv. history or not? Chat history or only last message." |
| 16 | §2.4 | On reviewing about 10 transcripts: "Needs more!! A human will not answer 10 questions without any value." |
| 17 | §2.5 | "The finance MCP needs its own separate testing." |
| 18 | §2.5 tools | "For a given interest rate, future value." "SIP: lump sum + monthly." "Good start." |
| 19 | §2.7 | On the effect checks: "This is super valuable!!" |
| 20 | §2.8 | "Problem with grader is it will tell the agent did best with what it had. Maybe a more neutral grading. Test this." |
| 21 | §2.8 | "If EMI was never calculated, grader will not flag issue. How do we let grader fix or find issues?" |
| 22 | §3.1 | "Nice!" |
| 23 | §3.3 | "So how do we show conflict to this prompt?" |
| 24 | §3.3 | "The real problem with this kind of prompt is simple: we unknowingly may add lines that conflict with this. We need to flag and check this before the run. An LLM call or something to see if we are making changes." |
| 25 | §3 | "We should run like a 100 real conversations with Hermes and verify all that we think: the prompt, memory, tools etc. Hermes is what they asked, so no surprises in it. The evals has to be precise on it." |
| 26 | §3.12 | On "Hermes's own text cancels in the paired difference": "This is wrong, v1 - v2: v2 could negate Hermes's own text." |
| 27 | §4.1 | On the own loop ending on `length` as `token_limit`: "This is bad, we should retry with the new limit." |
| 28 | §4.8 | "Contradict yourself" (cleanest arm for D9, yet D9's harness is open). "This is a vanilla agent and in some ways the most configurable. In the video we need to make that clear. Also the estimation of cost vs time have to be perfect here." |
| 29 | §5.2 | "Good contrast against Hermes." |
| 30 | §5.4 | On model names that change LangGraph's requests: "Interesting, how do we account for and show these?" |
| 31 | §5.8 | "More than empty: if an agent shows a calculation without a tool call, should flag error or at the minimum highlight." |
| 32 | §7.2 | On the Agents SDK system prompt being unverified: "Please verify asap." |
| 33 | §8.1 | On "memory on and empty vs on and seeded: comparable": "This is risky, memory may be diff across runs." |
| 34 | §8 | "For Hermes, their own instructions and conventions are quite the challenge. Let's deal with it properly." |
| 35 | §8.3 | "Judge LLM is our money maker. I have been using it for a year. Main worries: bad convs that no real human would have graded as pass; end goal weighted too high; the persona of the judge not good enough; cognitive load is 0 for an LLM, human? [50 words?]" |
| 36 | §9 Q5 | Grading non-answered endings: "We must scope this pre-run." |
| 37 | §9 Q7 | Hermes prompt-cache markers: "Whichever makes it stable." |
| 38 | end | "I think we are fine, main concern is the LLM as judge. It has to be clear where to trust or not." |

## What already holds

- 32: verified since v1. The Agents SDK adapter's probe shows the system message equals our prompt byte for byte, and the SDK adds no text (guide v2, chapter 7).
- 15: the simulator sees the whole visible conversation, with roles flipped (its own messages as assistant, the agent's as user), never tool calls. Guide v2 says so; v3 will say it in one line.
- 4, 8: partly built. D25 makes the API refuse, when the config is created, a setting the model rejects (temperature on Haiku 5.5) or the harness does not support. What is missing is the fix hint and showing it in the UI.
- 5: N trials per task per config is built (the engine and the kill test).
- 9: tokens per trial with an interval sit next to quality on the Compare screen of the design; the API stores per-trial tokens from LiteLLM.

## Guide corrections (no decision needed)

- 26: correct. The prompt's effect measured on Hermes is the effect *inside Hermes*: v2 can interact with Hermes's own text (for example, a warmth line against Hermes's "be direct, one-line answers"), so nothing "cancels". The effect on another harness can differ. Rewrite §3.12 and §8.1.
- 28: remove the contradiction in §4.8, and describe the own loop as the vanilla, most configurable baseline.
- 33: §8.1 "memory on and empty vs on and seeded" becomes "with caveats": seeds and in-trial writes can differ across runs; the integrity hashes before and after each trial are the check.
- 1, 29, 30: §8 gets a short "what a cross-harness comparison really compares" box, and §5 says how model-name rewrites are caught (see platform item 2).

## Platform work this calls for

1. **Bad configs caught before the run, with a fix** (3, 4, 8, 30). The API refuses with a reason and a suggested fix ("Haiku 5.5 rejects temperature; remove it or pick a model that takes it"), and warns on LangGraph model names that rewrite requests. The Config screen shows each refusal inline and greys out settings a harness or model ignores.
2. **Rendered prompt and conflict check** (23, 24, 34). For each config, show the full system prompt the model will get (Hermes's text plus ours), and run a conflict check of our prompt against the harness's own text before the run: an LLM call that lists contradictions such as "be direct, one-line answers" against "warm, under 250 words", or Hermes's "batch tool calls" against `parallel_tool_calls: false`. A real call, so it needs a sign-off rule.
3. **Number provenance** (21, 31). A platform-level check on every final answer: every money amount must appear in some tool result; an amount with no tool behind it is flagged as an unsupported calculation. Plus a grader primitive for tasks: required tool calls (for example `calculate_emi` must have been called).
4. **Lineage** (6, 7, 10). A config or experiment can name its parent. "Fork this config, change one thing, re-run, compare with the parent" becomes the main flow, and Compare can take the parent experiment as arm A.
5. **More than two arms** (11). Experiments already take a list of configs; the stats (SP6) compare each arm with a baseline arm, corrected for multiple comparisons.
6. **Run controls and early stopping** (13, 14). Pause, resume and stop on a running experiment, and stop rules: stop when infra failures pass a rate, when projected spend passes the cap, or when a smoke batch passes nothing. *Pushback:* stopping an A/B run early because the difference already looks big (or small) is "peeking"; it inflates false positives unless the test is designed for it (a group-sequential test). Guard rules are safe; effect-based stopping needs your call.
7. **Parallel trials** (11). Several worker containers per harness (`docker compose up --scale worker-hermes=4`), with the estimate's time using the real concurrency.
8. **Cost and time estimates** (28). Per-harness start-up and per-call latency and tokens from earlier trials, and estimate against actual shown after every run.
9. **Simulator realism** (16). The client loses patience when it gets questions without value: after two advisor turns with no answer it says so, and ends after a third.
10. **Finance MCP** (17, 18). Independent tests of every calculator against a second implementation; `sip_future_value` takes a lump sum as well as the monthly amount (a toolset version change).
11. **Hermes verification run** (25). About 100 real conversations on Hermes, with checks on everything we claim: the rendered prompt, tools seen, memory off and on, compression never firing, the cache markers, malformed-call repairs, call counts against LiteLLM. A real run that needs your sign-off.

## The judge (35, 38, 20, 36): design for you to own

- A per-criterion trust map. Agreement with your labels is reported per criterion and per task, with intervals; a criterion below the bar (D8) is shown as "judge not trusted here" and kept out of the headline verdict. The Compare screen says, next to each judged number, whether the judge is trusted for it.
- Rubric levers for your four worries:
  - "bad conversations a human would not pass": add a whole-conversation "would a real client be satisfied" criterion, checked against your labels;
  - "end goal weighted too high": score process and experience criteria separately from the outcome, never summed into one pass;
  - "judge persona": the judge reads as the client's advocate, blind to harness and model, and quotes evidence;
  - "cognitive load is zero for an LLM": a length and readability criterion with a stated budget (your "50 words?"), and the judge rates whether a stressed client could act on the first two sentences.
- 20 ("it did its best with what it had"): the judge grades against the task's reference facts, not against what the agent had seen, so missing a tool call cannot be excused.
- 36: how step-limit, timeout and token-limit endings are graded goes into the analysis plan before the run.

## Decisions to ask, one at a time

1. Hermes's own guidance (34, 24): tie its "Parallel tool calls" section to our `parallel_tool_calls` setting and show the rest with the conflict check, or keep everything as shipped and only flag it.
2. Early stopping (14): guard rules only, or also stopping on the effect with a sequential test.
3. Lineage (10): parent links on configs and experiments, with Compare able to use the parent as arm A.
4. More arms (11): each arm against a baseline arm with Holm correction.
5. Own loop on a cut-off reply (27): end as `token_limit`, or retry once with a raised cap as Hermes does.
6. A config error mid-run (3): pause the whole experiment (D26 today), or only the arm with the bad config.
7. Conflict-check calls (24): a small standing allowance, or sign off each check.
8. The 100-conversation Hermes verification run (25): sign-off with an estimate.
9. Prompt-cache markers (37): "whichever makes it stable" means off, the same as every other harness; record as decided.
