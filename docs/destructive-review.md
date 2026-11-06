# Destructive review, 6 Nov 2026

Five reviewers tried to break the platform at commit `b94b77d` (claims vs code, statistics, engine and API, graders and isolation, UI). This file keeps every finding, its evidence and its fix status. Owner items (the Conclusion, the video, the held-out labels) are Rishi's. Out-of-scope items go to `docs/known-limits.md`; everything else is fixed.

Status key: open, fixed (commit), limit (moved to known-limits), owner (Rishi).


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
