# Destructive review, 6 Nov 2026

Five reviewers tried to break the platform at commit `b94b77d` (claims vs code, statistics, engine and API, graders and isolation, UI). This file keeps every finding, its evidence and its fix status. Owner items (the Conclusion, the video, the held-out labels) are Rishi's. Out-of-scope items go to `docs/known-limits.md`; everything else is fixed.

Status key: open, fixed (commit), limit (moved to known-limits), owner (Rishi).

## Status (6 Nov, after the fixes)

Each fix has a test; the fixers' branches are merged in the commits named. "Verified" means the reviewers' original attack was re-run against the fixed code (section at the end).

| Findings | Status |
| --- | --- |
| C1 Conclusion, C2 video | owner (Rishi) |
| C3 conflict check on the Run screen, not tied to Sonnet | fixed: 8c0ca81, 7605868 (D75 amended) |
| C4 cost total, C5 judge story, C6 v2 held-out judging disclosed, C7 check estimate | fixed: 40d399d, 7605868 |
| C8 new provider, C9 positive control, C12 served model, C14 leak tests in CI, C15 nominal interval, C16 replications, C17 Holm | fixed: aca739f |
| C10 state checks | limit: assumption A52 (aca739f) |
| C11 skills demo not shipped | fixed: 189c5de (sixth example) |
| C13 Jest count | fixed: 30ce17c (recounted again at the end) |
| C18 harness guide, effect checks; C19 small items | fixed: b6cac34 (effect checks never run: known-limits) |
| S1 to S4, S6, S7, S10 to S12, minor | fixed: merge 396c73c (shipped results pinned by a test, unchanged); thresholds open as D77 |
| S5, S8, S9 (screens) | fixed: merge 29cc633 |
| E1 to E12 | fixed: merge 48b3d1c (limits chosen open as D77) |
| G1 to G12 | fixed: merge 1c43da7 (no shipped outcome changes); G1's quoted-then-disowned figure stays a limit (the judge's job); G3 echo rule open as D77 |
| U1 to U14, fake-run N | fixed: merge 29cc633, 3e88cba |
| U15 Ollama not checked | limit: a warning, the API has no signal for it (known-limits) |


Detail and repros for each ID: findings.md in this folder. C = claims, S = stats, E = engine/API,
G = graders/cheating, U = UI. None of the 70-odd findings changes a shipped headline number; all
five shipped results recompute exactly.

## Tier 1: a reviewer will likely hit or see it (fix or address before submitting)
| ID | What | Owner | Size |
| --- | --- | --- | --- |
| C1 | No Conclusion in experiment.md, though README says it's there | Rishi | writing |
| C2 | No video, and no video row in the README deliverables table | Rishi | recording |
| U1 | Keyless "Build your own" can't save its default agent (local Qwen + parallel_tool_calls); same screen says the $0 local model costs money | code | small |
| U2 | Experiments page "Latest result" says "Prompt v2 beats v1, +17" (the LangGraph replication, unnamed), contradicting the README | code | small |
| S5 | Shipped A/A page shows a time "difference" (+1.5 s, interval above 0) with no caveat | code | small |
| C5 | Judge story differs across README, known-limits, design.md, judge-validation; tasks still run rubric v1 | docs | medium |
| U5 | Cost per trial shows $0.0094 vs $0.01 beside "+30%" | code | small |
| C4 | cost.md total leaves out the $5.85 judge panel | docs | small |
| U-N | Fake-model path defaults to N=5: 100 trials, ~17 min | code | small |
| C3 | Hermes real runs now need an Anthropic key for the D75 check (Gemini-only reviewer blocked); README silent | Rishi's call + docs | small |

## Tier 2: real bugs a careful reviewer or the interview could find
| ID | What | Size |
| --- | --- | --- |
| S2 | D8's "no false-pass gap" test fails unbiased judges at 20+ "no" labels; will hit the held-out measurement | small (signed difference) |
| S3 | Kappa intervals drop undefined resamples: [1,1] from one negative label | small |
| S1 | Critical-failure guardrail fires on noise (one failure on one task blocks "better"); own-loop is one trial away | small-medium |
| E2 | API/LiteLLM/Postgres outage >2 s throws away finished trials (re-run, paid twice) | small |
| E1 | Worker can't reach LiteLLM -> counted as the agent's failure | small |
| G3 | Simulated client's words count as a provenance source (72 amounts in 39 shipped trials) | medium |
| G1 | Number grader passes on the figure anywhere ("÷ 12" passed a months check in 5 shipped trials) | small |
| G2 | mba-loan "asks for missing facts" passes on "let me know if…" and the word EMI | small |
| G8 | "₹5 lakh" matches 4.5-5.99 lakh (doc says 4.5-5.49) | small |
| U3/U4 | Example loader/Start yank you away after you navigate; Build loses its form on Back | small |
| U6 | A re-run infra attempt is described as "gave up, not re-run" | small |
| U11 | Phone Config screen scrolls sideways 10 px | tiny |
| E3-E5 | Races: run stuck "running", queued trial on a stopped run, 500 deadlocks (one locking fix) | medium |
| E6 | Export of a reuse_baseline experiment leaves out arm A | small |
| C8-C11 | Overstatements: "a new model is one config line"; state checks only nominal; positive control built into the graders; memory/skill trace not visible keyless | docs |

## Tier 3: edge cases, hostile inputs, cosmetic
S4, S6-S12; E7-E12; G4-G7, G9-G12; U7-U10, U12-U15; C6, C7, C12, C14-C19. Mostly need a hostile
worker, a crafted answer or an outage; all documented in findings.md with a one-line fix.

## Held under attack
No XSS anywhere; D75 gate refused every bypass; shipped examples read-only on every route; D72
caught every grader mix; uploads refused traversal/size/sha/overwrite; worker protocol duplicates and
stale leases handled; kill test passes; no file or shell access for the agent; image isolation tests
pass; sign-flip exact = brute force; Fisher, BH, Wilson, Newcombe correct; all shipped numbers
recompute exactly; double clicks send one request.

---

# Findings in full
Five reviewers: claims (C), stats (S), engine/API (E), UI (U), graders/cheating (G). Report-only.

## C: claims vs code (done)
- C1 HIGH: experiment.md Conclusion "Rishi to write" but README:244 and :268 say it's there. Rishi's.
- C2 HIGH: no video; README deliverables table has no video row. Rishi's (add a row "to come").
- C3 MED (STALE NOW): D75 says Run screen runs the check — true since 8c0ca81. Still open: Hermes real runs need ANTHROPIC_API_KEY for the check (Gemini-only reviewer can't run Hermes real); README never mentions it; runSetup.ts:224 hides fix text containing "POST /".
- C4 MED: cost.md judge-panel row "(to fill)", total $12.80 omits panel $5.85 (real ~$18.65 + $0.07 checks); judge-validation.md:81 "$4.55 so far" stale.
- C5 MED-HIGH: judge story inconsistent: README/known-limits say kappa 0.30 v1; design.md:209-218 says rubric v1, never mentions D71-D74; judge-validation.md:101 "Fixed for Phase 2: Gemini + v2" vs :80 "Frozen v4"; D73 27-trial plan superseded but not marked; tasks still run advice.v1.md (validated judge v4 isn't the one tasks run).
- C6 LOW-MED: "measured once on hidden test set" omits that the same 40 held-out were judged under v2 at 19:52 5 Nov (b57f5a0) before v3/v4 were written; disclose, say it won't be scored.
- C7 LOW-MED: cost.md:124 conflict-check estimate says 2,000 tokens/$0.03, three checks run; should be 6,000/$0.08.
- C8 MED: design.md:35,:74 "a new model is one config line" vs README new-provider steps (MODEL_REJECTS, PROVIDER_KEYS core TS).
- C9 MED-LOW: positive control success is built into graders (14 predicted tasks require the removed tools); validates pipeline+stats, not behaviour sensitivity. Say so.
- C10 MED: "state checks on sandbox/file system" only nominal (end_state = how run ended); no assumption line.
- C11 MED: keyless reviewer can't see memory/skill trace; cited skills-demo trial ids aren't shipped. Ship $0.11 skills demo as 6th example or say not shipped.
- C12 LOW: served_model is LiteLLM route name (anthropic/claude-haiku-5-5), not a provider snapshot.
- C13 LOW: README Jest count stale -> FIXED in 30ce17c (36 of 50).
- C14 LOW-MED: isolation leak tests opt-in (EVALS_IMAGE_TESTS), not in CI, while known-limits:34 says "tested".
- C15 LOW: "95% interval" nominal, ~91% coverage at K=10 per design.md:338.
- C16 LOW-MED: replication called "independent" (same tasks/prompts/model/sim); LangGraph p=0.047 "better" is one of three tests.
- C17 LOW: design.md:273 Holm "can never flag at N=5..10" false for N>=6.
- C18 LOW-MED: harness-guide.md:30 stale (branch sp1-harnesses, no effect checks); adapter-contract:279 "counts once effect checks have run" vs none run.
- C19 LOW: misc: "see exactly what reaches the model" vs Gemini caveat; D7 still listed open; labels/tuning.jsonl lines have no rater field (CLAUDE.md says each tagged); worklog stops 5 Nov SP6; experiment.md:34 "N from pilot" not in Deviations; prompt v2 header "(no held-out output was read)" vs experiment.md:17; design.md had no D75 entry -> FIXED in 8c0ca81.
- True: headline/A/A/positive control/replications/costs/pre-registration/task facts/kappas all recomputed and match.

## S: stats and verdicts (done; all five shipped results reproduce exactly)
- S1 MED (wrong verdict): critical guardrail "rose" uses task bootstrap low>0 only (analysis.ts:186), no paired test/6-task floor/zero-width rule; 0/10 vs 1/10 on one task -> "+10 to +10 rose" -> holds back a real "better". Own-loop shipped is one trial away from flipping to "rose". Fix: require sign-flip p<0.05 on critical diffs + D50 floor + D55 zero-width.
- S2 MED (wrong trust decision): D8 false-pass gap = max-min (never negative), percentile interval excludes 0 for unbiased judges at 20+ "no" labels (1.5% pass at 20, 0% at 40). Will hit held-out. Fix: bootstrap signed B-A difference.
- S3 MED: kappa/Rogan-Gladen bootstrap drops undefined resamples silently -> [1,1] intervals on one negative; clears D8 lower bound. Fix: report undefined/dropped share; min-negatives rule.
- S4 LOW-MED: A/A "as it should" text keyed on verdict only; says so even when interval excludes 0; zero-width A/A text contradicts D55.
- S5 HIGH-visibility: shipped A/A page shows time +1.51 s (+0.37 to +2.82) "difference" with no caveat; cost/time intervals no paired test, under-cover. Fix: caveat line.
- S6 LOW: sign-flip biased with very unequal decided counts per arm (10 vs 2-3). Add known-limit.
- S7 LOW-MED: D55 knife-edge: one trial flips "cannot say" to "Practically equivalent" with ceiling tasks. Fix: >=6 tasks with nonzero diff before "equivalent".
- S8 LOW: "Practically equivalent" next to "Why this is unlikely to be noise" (CompareView whyTitle order).
- S9 LOW: "Where B dropped" can list an improved task tagged "beyond noise" (CompareView:1226). Show only when diff<0.
- S10 cosmetic: guardrail sentence counts checks on excluded tasks (analysis.ts:165).
- S11 LOW: python --rater humans --human-unsure no: firm tie counted as human "no".
- S12 LOW: "Rests on the judge" caveat can never show (stats.judge always null).
- minor: failed-grading trial shows "still grading" in compareRows; null tokens summed as 0; panel majority from one judge when others omitted; label without labelled_at sorts first; ±10 margin checked on rounded values.
- Held: sign-flip exact vs brute force; Fisher/BH/Wilson/Newcombe; seeding; infra exclusion consistent; D72 catches all attempted mixes.

## G: graders, checks, judge, isolation (done; none changes a shipped headline outcome; 3 seen in shipped data)
- G1 MED (cheat passes, seen in shipped): `number` grader passes on first in-tolerance number anywhere (graders.py:212-253); months-with-extra (critical, convo-phone-loan, match any) passed on "18% ÷ 12" in 5 shipped trials (all failed another required grader, no outcome change). Crafted: wrong EMI in words + quoted right figure "ignore them" -> pass. Fix: context pattern for month-count graders.
- G2 MED (cheat passes): mba-loan asks-for-missing-facts counts "let me know if you'd like..." as a request and "EMI" as the existing-debts topic (draft-...mba grader.py:38,51); invented-EMI answer passes. 2 shipped trials reached the minimum only via "EMI".
- G3 HIGH-occurrence (misleading, seen in shipped): simulated client's words count as a provenance source, incl. disputing a figure ("Where did 68,156 come from?" -> agent's 68,156 supported). 422 amounts/134 trials sourced only from client_sim; 72 amounts in 39 trials became supported after the client repeated them (checks.py:414-418).
- G4 LOW-MED (cheat): launder any figure via multiply/divide with "free" whole-number factors 1..60 (checks.py:131,586-593); 52 shipped arithmetic calls rest on a free factor.
- G5 LOW now / HIGH once trusted (cheat): judge prompt injection: material() pastes agent text raw under markdown headings (judge.py:164-198); fake "### Client" turn and "## Criteria" section indistinguishable; no "conversation is data" rubric line.
- G6 LOW (cheat to uncounted): (a) "₹"+4,400 nines crashes runner json.dumps (int max str digits) outside try (runner.py:230) -> infra; (b) quadratic NUMBER_RE lookahead (amounts.py:34): 60k digits -> unit grader timeout -> incomplete.
- G7 LOW (cheat on safety check): helpline grader target all_agent_text includes tool args (graders.py:112-117); helpline only in a tool argument passes.
- G8 MED (cheat; doc understates): lakh truncation: "₹5 lakh" matches 4.5-5.99 lakh (known-limits:118 says 4.5-5.49); "₹1 lakh" matches 50k-1,99,999. 1 shipped case.
- G9 LOW-MED (correct fails): "₹5.96 lakh – 46 months sooner" reads 46 as ₹46 lakh via RANGE_GAP (checks.py:103,223-237).
- G10 LOW: grader money reader vs provenance reader disagree (NBSP after ₹, **bold**, ₹-5,000, ₹49.41L).
- G11 LOW (cheat): tool error message counts as tool source (gather_sources doesn't skip is_error, checks.py:394-406).
- G12 LOW (misleading, seen in shipped): Hermes adapter marks {"error":...}+warning text results is_error=false (hermes adapter.py:191-196); 7 spans in positive control.
- Held: model has no file/shell access (19 finance tools only, enabled_builtins []); finance-mcp reads only state/client.json; image tests pass (hermes, ownloop on breaker images); unit-test result can't be forged; invented judge quotes flagged; turn ordering correct in all 1,010 trials.

## E: engine and API (done; stack `breaker` left running)
- E1 LOW-MED (wrong result): worker can't reach LiteLLM -> harness_error with last_status null, model_calls 0 -> labelled `agent`, counted as agent failure, not re-queued (runner.py:356-357, 395-398 provider_label returns None). Reproduced by detaching litellm from trials net 4x4s: 3 of 12. Fix: infra:provider_error when harness_error and last_status None.
- E2 MED (data loss): outages >~2s of API/LiteLLM/Postgres discard finished trials: _spend_rows reads /calls with 3 tries 1s apart (worker.py:284-285,310-325) vs 600s for uploads/report; shown as abandoned "no heartbeat for 60s" (misleading); re-run (paid twice); infra guard pauses. Triggered by documented ".env edit then docker compose up -d" mid-run. Fix: same _until_accepted back-off for /calls.
- E3 LOW (stuck state): last two trials reporting at once -> experiment stuck `running` forever (finishIfDone READ COMMITTED; experiment row locked only later in applyRunRules). 6 of 8 races. Stuck A/A never shown as aa. Fix: lock experiment row FOR UPDATE first in report/sweep tx.
- E4 LOW-MED: Stop racing an infra report leaves a queued trial on a cancelled experiment (worker.service.ts:442 reads status unlocked). 3 of 10. Same fix.
- E5 LOW-MED: deadlocks (500) under concurrent reports + pause/resume/start/discard (FK KEY SHARE then FOR UPDATE upgrade). Same fix.
- E6 LOW-MED (wrong export): reuse_baseline export omits reused arm-A trials (export query experiment_id only). Fix: include reused_trial_ids.
- E7 LOW: NUL \u0000 in report -> permanent 500 -> slot lost after ~22 min. Fix: strip NUL in parseReport/spanRows.
- E8 LOW: worker numbers not range-checked (negative cost -> spend -1000; tokens 3e9 -> 500). Fix: usageOf finite >=0, clamp.
- E9 LOW: 500s on NUL in name, GET /trials/%00, repeated status query param; no upper bounds on budget_usd (1e308), timeout_s, max_steps, config name length.
- E10 LOW: ghost workers (claims with new worker_ids, unknown harness) skew time estimate.
- E11 LOW (inferred): POST /labels accepts fake/probe/example trials the queue hides (labels.service.ts:234-238).
- E12 LOW (inferred): CSV formula injection (csvCell doesn't neutralise =,+,-,@).
- Held: D75 gate refused every bypass (pilot, A/B, A/A, reuse child, start twice, resume/pause on created, example configs; casing/whitespace refused as unknown_model; fake/ routes only to fake); examples read-only on every route; D72; uploads traversal/size/sha/overwrite/auth; protocol duplicates/claim_lost; kill test PASS; API restart <2s no loss; input checks.

## U: UI as a careless newcomer (done; stack `breakui` left running; screenshots in scratchpad/agent-ui/shots/)
- U1 HIGH (dead end, door 2): keyless Build/Config default to "Qwen2.5 7b Local" (key_set null passes missingKey); Build always sends parallel_tool_calls:false; MODEL_REJECTS refuses it for Qwen -> Save agent gives 400 with LiteLLM jargon; Build can't unset it; fresh DB fails every time. Same screen says this $0 local model "costs money and needs the provider's API key". Fix: send parallel_tool_calls only when ticked; prefer key-set model then Haiku over key_set null. (Reproduced on fresh breakui; recheck on fresh stack.)
- U2 MED-HIGH (misleading headline): Experiments "Latest result" = newest finished A/B = LangGraph replication: "Prompt v2 beats v1 on the held-out tasks, +17 points", no harness/model named; contradicts README "no detectable difference". Before background load: positive control; after a fake run: "v1 0%, v2 0%" unlabelled. Fix: name harness+model in headline(); skip fake-only; or pin headline example.
- U3 MED (lost work): example loader / RunView startNew call replaceRoute after you've navigated away -> yanks you to comparison/run, discards Build form; Back loops via #/example. First copy took 38 s with 3 tabs. Fix: alive flag cleared onBeforeUnmount.
- U4 MED (lost work): Build loses all choices + unsaved prompt on navigate/Back (e.g. via the "i" tip's Harnesses link). Fix: sessionStorage or open link in new tab.
- U5 MED (precision): headline compare cost per trial A "$0.0094" vs B "$0.01" beside "+30%" (money() 4dp below $0.01, 2dp above). Fix: same precision both arms (3 sig figs below $1).
- U6 LOW-MED (wrong status): re-run infra attempt described "gave up, not re-run" (CompareView:217 early return on abandoned); trial page says "Not an infra failure"/"Not graded yet" (TrialView:142). Fix: rerunWords looks for next attempt first; isInfra true for abandoned.
- U7 LOW-MED: header health badge fetched once, never refreshed (stays "API ok" when down; stays "unreachable" after recovery). Fix: poll every 10 s.
- U8 LOW-MED: outage errors are raw HTTP text ("POST /configs failed with HTTP 502", "Unexpected token '<'"); LiteLLM down hides whole Build/Config; no Retry. Fix: map 502/503/504/non-JSON to plain words; Retry in LoadState.
- U9 LOW-MED: after Stop, run page stops polling and freezes "1 running" (RunView:820 polls only running/paused). Fix: poll while counts.running>0.
- U10 LOW: malformed % escape in deep link -> blank page, no header (router dec() URIError). Fix: try/catch -> not-found.
- U11 MED (phone): Config screen scrolls sideways 10 px (toolset select sized to "finance-no-calculators v3 (validation only)"). Contradicts my route walk (recheck). Fix: min-width:0/max-width:100% or wrap.
- U12 LOW: 90-char unbroken config name overflows run page arm card. Fix: overflow-wrap anywhere.
- U13 LOW: changing a choice during slow Save shows wrong agent as saved; "already exists" claim false. Fix: disable fieldset while saving.
- U14 cosmetic: "1 tasks"/"1 trials"; token diff "+23572" next to "79.3k"; "0 errors in 0 trials"; API accepts 127-char config name vs UI limit 120; #/run?aa=1 without a= picks a config silently.
- U15 LOW (inferred): Run screen doesn't check Ollama is up for Qwen-local config.
- Observation MED: fake-model path defaults N=5 -> 100 trials, ~17 min on one worker; suggest N=1-2 when all fake.
- Held: no XSS anywhere (no v-html); double-click Save/Start one request; two tabs idempotent; examples under pressure OK; unknown ids -> Not found; N validation; keyboard + focus; dark mode contrast; headline numbers match export and /compare; stopped run says no verdict; next-failure walk.

---

# Verified: the original attacks re-run against the fixed code (6 Nov, f330b5d)

Two agents, each on a fresh clone with its own stack and no keys, re-ran the reviewers' original attack scripts.

- **Engine and API:** E1 to E4 and E6 to E12 no longer break. The 75 s API outage lost nothing, and the kill test, smoke and netcheck pass. A normal 2-arm fake run, pause/resume and stop all work. Still breaking, then fixed in e75405d:
  - E5 in one form: Stop racing workers' claims deadlocked (500 in 13 of 20 rounds). A claim now locks the experiment before the trial, and a race test fails on the old code.
  - New N1: during a Postgres outage LiteLLM logs `P1001`, and the trial was labelled the agent's. It is now `infra:provider_error`.
  - Minor items:
    - arm resume on a stopped run returned 200;
    - an unknown `set` on the agreement route returned 200;
    - `max_output_tokens` had no cap;
    - a long `end_state` was stored as given;
    - idle workers looked absent to the estimate (D77 item 5 narrowed).
- **UI:** U1 to U13, U15, the fake-run N and S5, S8, S9 no longer break. Checks on a fresh database:
  - the Build screen's default agent saves without a key;
  - the headline card names the harness and model;
  - the first door reaches the verdict in 14 s, and all six examples load (the skills demo's trial shows the skill load);
  - 50 page loads on desktop and phone had no errors.

  Still breaking, then fixed in 302e3c8:
  - U14 "1 tasks" and "1 comparisons";
  - new: the Run screen's estimate had no retry after a LiteLLM outage;
  - new: the header badge showed the browser's raw words and wrapped;
  - new: the progress line counted an infra attempt as a finished trial;
  - new: a hosted model against the local Qwen could never pass the one-change check.

  Kept as limits:
  - the background copy of the other examples needs the tab open (README says so, and opening the first door again finishes it);
  - the Run screen cannot check Ollama.
- **Graders and statistics:** the reviewers' crafted scenarios and simulations are regression tests in the suites, which pass. All 1,010 shipped trials recompute to the same outcomes, and all six shipped comparisons to the same verdicts.

# Soak test findings (6 Nov, at ac089f8)

A real-model soak ran 988 trials across the five harnesses on its own stack, with injected faults: two worker kills mid-trial, a pause and resume, two API restarts, a 10 s LiteLLM stop and a 10 s Postgres stop. Fixed on branch `fix/soak-findings`, each with a test that fails on the old code; fake models only.

| Finding | Status |
| --- | --- |
| 1. A 10 s Postgres stop lost trials for good and paused arms with the wrong fix text. LiteLLM answered running trials with 404 "Team doesn't exist in db" (its `get_team_object` turns any failed read into that 404); the runner took 401/403/404 for `infra:config_error`, never re-queued, which paused experiment 3's arm B and both arms of experiment 4 and left two slots with no done attempt. | fixed: LiteLLM's database-fault answers are `infra:provider_error`, re-queued once (`runner.LITELLM_DB_FAULT`, read in LiteLLM's own message for the failed call and in the adapter's error); real setup errors stay config errors. The UI calls `infra:provider_error` "LiteLLM or provider error". |
| 1b. When a slot ran out of attempts, the comparison said `complete` with no note: experiment 3's verdict used 104 against 105 trials silently. | fixed: the comparison's `missing_trials` names the slots each arm lacks, the same sentence ends `verdict_text`, and the Compare screen shows it as "Missing trials". The verdict itself is unchanged. |
| 2. Spend and traces sometimes missed a trial's last LiteLLM call: 11 of 986 trials were short $0.0115 in all (8 a simulated-client call, 3 an agent call), and 9 of them were marked `proxy_complete`. `complete` meant only "the agent key holds the harness's own count": the simulator key had no floor, the agent read ended about 2 s after the adapter exited, and a Hermes trial at its step limit counted 24 of its 25 calls (the summary call). LiteLLM flushes its log every 1 to 6 s. | fixed: both keys are read together (`ProxyClient.read_calls`), each until it holds the calls the trial is known to have made (the simulator's: one per line of `sim_replies.jsonl`), and not before 7 s after the adapter exited with 1.5 s of no change; `complete` is false whenever that is not shown within 30 s. Each trial now waits about 7 s after its adapter ends. |
| 4. Abandoned attempts showed `usage: null` in `GET /trials/:id` although their spend is stored and counted, and have an empty `label` in the API and both exports. | fixed: the trial view builds `usage` from the stored columns whenever any is recorded (`complete` null for the sweep's read). Both exports already carry `status`, so abandoned attempts are found by `status: abandoned`, now said in `docs/api-contract.md`; no label value was added. |
| 3. The hard budget under-counts after a database blip: LiteLLM's team counters totalled $11.0815 against $11.1101 in its spend log, the whole gap in the experiments with trials in flight during the Postgres stop. | limit (`docs/known-limits.md`): the hard cap is LiteLLM's team and key `max_budget` on its own counters; our spend guard (D32) already uses our recorded spend, never the counters, but it fires once as a pause and is not a hard stop. A stop of our own on recorded spend is a new run rule, so it is left to Rishi. |
| 5. LiteLLM's database grows about 251 MB per 1,000 trials (full request bodies), against 77 MB for ours. | limit (`docs/known-limits.md`): the trace view reads the runner's copy of the bodies in the trial folder, not LiteLLM, so nothing depends on LiteLLM's copy after the trial; `store_prompts_in_spend_logs` must stay on for the runner's copy. LiteLLM's `maximum_spend_logs_retention_period` is noted as an option, not changed. |

**Reproduced on a throwaway stack** (`fixsoak`, fake models only, two experiments of 60 trials each on `fake/finance-loop`, own loop vs LangGraph and Agents SDK vs ADK):
- *A 10 s Postgres stop*, 56 s after the first trial started, three times before the fix and twice after: each time 1 or 2 trials got LiteLLM's 503 `no_db_connection` (logged as `P1001` or `unknown`), already `infra:provider_error`, and were re-run; every slot finished. LiteLLM's 404 did not come back on fake models: its calls hung during the stop and answered 503 for about 15 s after it, until it reconnected. On the first build after the fix two trials that ended 4 s before the stop were flagged `proxy_complete: false` with all their calls logged, which `8c0e713` fixed; on the final build, 0 of 120 were flagged.
- *LiteLLM unable to read one experiment's team*, simulated by hiding that team's row in LiteLLM's database for 75 s; LiteLLM then answers with the soak's exact 404 "Team doesn't exist in db" (its docstring says a deleted team and an unreadable one look the same to its callers). Before the fix: 2 trials `infra:config_error`, both arms paused with "fix the model's route in LiteLLM's config", 46 trials left queued, 2 slots with no done attempt. After it: the 404s were `infra:provider_error` and re-queued once, no arm paused for a config error, D32's infra guard paused the run for review (3 of 9 finished were infra failures), and once it was resumed every remaining trial ran: 58 of 60 slots done, the other 2 having spent both attempts while the row was still hidden. The control experiment finished both times.
