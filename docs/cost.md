# Cost

Required by the brief: cost per experiment as a formula, actual spend from the experiment, and how to reduce cost.

## Formula

```text
experiment cost = Σ over tasks × configs × N trials of  trial cost   (+ judged trials × judge cost per call)

trial cost = Σ over the trial's model calls (agent and simulated client) of
               uncached input × input price
             + cache reads    × cache-read price
             + cache writes   × cache-write price
             + output         × output price
```

Two things make this non-linear in the number of calls:

- **Every call resends the conversation so far.** Call k carries the system prompt and tool
  schemas plus everything said and every tool result before it, so input per trial grows faster
  than the number of calls. Measured on Haiku 5.5 (4 Nov, 40 real trials: the label batch and
  D39's memory-off run): the own loop averaged 5.0k input tokens at 1 call and 85.6k at 11 calls (5.0k to 7.8k per
  call); Hermes 6.4k at 1 call and 141.8k at 13 calls (6.4k to 10.9k per call). Doubling
  `max_steps` can more than double a long trial's cost.
- **Provider prompt caching prices part of the input at a tenth.** Hermes, as it comes, marks its
  prompt for Anthropic's cache; D31 (4 Nov) turned those markers off in every config (the adapter
  writes `prompt_caching.cache_ttl: "off"`), so no harness uses the cache from then on and costs
  compare like for like. Trials before the change were cached: in label batch 1, 86% of Hermes's
  prompt tokens were cache reads (581,765 of 678,844, read at $0.01 instead of $0.10 per MTok),
  so its input cost about a quarter of list price; in the two client-sim checks, 79% and 65%. From
  the D39 runs on: none, in 1.87M prompt tokens. LiteLLM's recorded spend matches the formula
  above when the four token kinds are priced separately. This is the provider's prompt cache,
  which only prices the prompt; LiteLLM's response cache stays off for trials.

The platform's estimate does not use this formula directly: it takes LiteLLM's recorded cost per
trial from earlier trials of the same config and task, so both effects are in it once there is
history, and tokens at list price (no cache) before that.

## Planning estimate

The planning estimate of 3 Nov, kept for the record (the measured figures below replace it): 8 LLM calls per trial, 8k input and 300 output tokens per call, no caching. That is 64k input and 2.4k output per trial.

| Model | Input $/MTok | Output $/MTok | $/trial | 400 trials | Price source |
| --- | --- | --- | --- | --- | --- |
| Opus 5.5 | 4.00 | 20.00 | 0.304 | $122 | Claude docs |
| Sonnet 5.5 | 2.00 | 10.00 | 0.152 | $61 | Claude docs |
| Gemini 3.8 Flash | 0.75 | 3.75 | 0.057 | $23 | Google AI Studio pricing page, checked 4 Nov (paid tier; cache read 0.075) |
| gpt-oss-120b | 0.15 | 0.60 | 0.011 | $4.40 | BenchLM, read 20 Oct, third-party |
| Haiku 5.5 | 0.10 | 0.50 | 0.0076 | $3 | Claude pricing page, checked 4 Nov (prompts up to 100k tokens; cache write 0.125, read 0.01; 5x above 100k) |
| GPT-6 Luna | 0.10 | 0.50 | 0.0076 | $3 | Costbench, as of 10 Oct, third-party |

- 400 trials is 20 tasks × 2 configs × N=10, the 3 Nov placeholder; the real headline ran 10 held-out tasks × 2 configs × N=10 = 200 trials.
- Sonnet vs Gemini Flash at 200 trials each: about $42.
- Judge estimate (D45, Gemini 3.8 Flash): 3k input and 300 output per call is about $0.0034, before any thinking tokens; 60 labelled trials × 3 repeats is about $0.61. On Sonnet 5.5 it would be about $0.009 a call.
- Check third-party prices on the provider pages before quoting them. Gemini 3.8 Flash is listed to rise to $1.50 / $7.50 from 1 Jan 2027.

Sources:

- [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Costbench: Gemini vs OpenAI](https://www.costbench.com/compare/google-gemini-api-vs-openai-api/)
- [BenchLM: OpenRouter](https://benchlm.ai/hosts/openrouter)

## Ways to reduce cost

**The formula on the real run** (headline, 5 Nov, Claude Haiku 5.5 at $0.10 / $0.50 per MTok): 10 tasks × 10 trials × 2 configs = 200 trials; v1 averaged 75.5k input and 3.8k output tokens a trial, v2 97.9k and 5.0k (about 86.7k and 4.4k overall), so the agent's cost is 200 × (86,700 × $0.10 + 4,400 × $0.50) / 1,000,000 = $2.174, plus $0.125 for the simulated client ≈ $2.30; LiteLLM recorded $2.2947 (the token averages above are rounded). The A/A run on the same tasks cost $1.959; v2's extra tool calls cost about 30% more per trial than v1.

What we did, and what each would save:

- **Fake models for development and CI: done.** Every test and CI run uses the scripted fake server, so building the platform cost nothing in model calls; real calls were only the signed-off runs in the table below.
- **A small pilot before the full N: done.** The discovery run used N = 3 ($0.32) to find failures and give labels before the N = 10 runs. The simulation table (`docs/design.md` section 6) shows more tasks buy more power than more trials, so N stays modest and K is where money should go.
- **Early stopping: built, not used on the final runs.** The futility check pauses an arm that fails its first graded trials (D32); it was off for the final runs because the verdict needed the full planned N, and the $4 caps protected the spend.
- **Provider prompt caching: measured, kept off.** Before D31, Hermes's cached trials paid about a quarter of list price for input; it is off in every config so harnesses compare like for like. Turning it on for both arms at once would cut cost without tilting a comparison; it does not affect independence, because the model still generates a new answer.
- **Fewer tools and fewer calls.** v2's extra arithmetic tool calls cost about 30% more per trial than v1; a leaner toolset or a prompt that batches sums would cut that.
- **The judge in batch.** Judging runs after the trials, so a provider batch API (Claude lists a 50% discount) fits it.
- **Never LiteLLM's response cache for trials,** because repeated trials would stop being independent samples.

## Actual spend

Every paid run, with its sign-off.

| Date | Run | Trials | Spend | Signed off |
| --- | --- | --- | --- | --- |
| 4 Nov | First real-model smoke on Claude Haiku 5.5, 5 harnesses × 3 trials (`runs/20261104T083111Z-real`) | 15 | $0.077 (LiteLLM's records) | Rishi, R8, estimate $0.20, cap $3 |
| 4 Nov | Two earlier attempts that never reached a model: a script path bug, then an unscoped API key rejected with a 400 | 6 | $0.00 | same |
| 4 Nov | client-sim v2 check through the engine: 3 conversation trials on Haiku 5.5 (own loop, Hermes, LangGraph), experiment `e_0mw22cinx2dade03d979bb3c4` | 3 | $0.039 | Rishi, D27 ("I'll show you 3 transcripts from v2") |
| 4 Nov | client-sim v3 check through the engine: 3 conversations on Haiku 5.5; every simulator reply came back empty (300-token cap used up by thinking), fix in progress | 3 | $0.013 | Rishi, D30 |
| 4 Nov | First Gemini 3.8 Flash trial (own loop, single question): one call took 3 minutes and the next got a 503 "high demand" after the 240 s timeout | 1 | $0.007 | Rishi, R8 (the approved 30-trial smoke) |
| 4 Nov | Gemini 3.8 Flash smoke, 5 harnesses x 3 trials, after the D16 retries: every trial failed at Google with 503 "high demand" then 429 "You exceeded your current quota, please check your plan and billing details" (the key's project is not on a paid tier); all labelled infra, none counted against an agent | 15 | $0.00 | Rishi, R8 (the approved 30-trial smoke) |
| 4 Nov | Label batch 1 (open coding): 15 draft tasks x own loop and Hermes on Haiku 5.5, experiment `e_0mw273dpt486807c2722a92dc`; all 30 answered | 30 | $0.135 | Rishi, R8, estimate $0.30, cap $2 |
| 4 Nov | D39 Hermes verification on Haiku 5.5: 10 trials each with memory off, on and empty, on and seeded; every check passed (`docs/hermes-notes.md`) | 30 | $0.275 ($0.082, $0.106, $0.087) | Rishi, D39, estimate $0.60, cap $2 |
| 5 Nov | Gemini billing check after Rishi enabled billing: one call to gemini-3.8-flash through LiteLLM ("Reply with the single word OK.", max 200 tokens): HTTP 200 in 2.4 s, "OK", 8 input and 61 output tokens (thinking included) | 1 call | $0.000235 | Rishi, "Enabled billing u can confirm" |
| 5 Nov | Clean-machine test on GCP: VM evals-qa-5nov (e2-standard-4, asia-south1, 80 GB), created 06:17 IST with a 4-hour auto-delete, deleted by hand at about 07:05; no model calls on it | 48 min | about $0.14 (estimate from list prices; GCP's bill is the record) | Rishi, "Yes, today" |
| 5 Nov | v1 discovery run: prompt v1 on Hermes with Claude Haiku 5.5, toolset finance/v3 (19 tools), the 11 discovery tasks x 3, Haiku as the simulated client, experiment `e_0mw33tqo41489091e4da80c75`; 33 of 33 answered, 0 infra failures | 33 | $0.321 | Rishi, "Approve N=3, cap $1" (estimate $0.22, range $0.11 to $0.44) |
| 5 Nov | Judge on the v1 discovery run (planned, D66, 13:03 IST): Gemini 3.8 Flash, rubric advice.v1, one call per trial on 33 trials of `e_0mw33tqo41489091e4da80c75`, to compare with Rishi's 33 tuning labels; expected about $0.35, approval budget $1 | 33 calls | $0.259 (LiteLLM, the judge key's spend) | Rishi, D66 standing allowance |
| 5 Nov | Headline v1 vs v2 on the 10 held-out tasks x 10, Hermes with Claude Haiku 5.5, `e_0mw38a1ym89666c6ccc6bfd13`; 200 of 200, 0 infra | 200 | $2.295 | Rishi, "Approve both, N=10" (expected about $1.95, cap $4) |
| 5 Nov | A/A calibration of v1 on the same tasks x 10, `e_0mw38a2282836ad0614b7c07f`; 200 of 200, 0 infra | 200 | $1.959 | same |
| 5 Nov | Second-provider check (planned 14:26): Gemini 3.8 Flash as the agent on the own loop and on Hermes, 5 single-message discovery tasks x 2 trials each, prompt v1, finance/v3; first guessed at $0.10 (wrong: Gemini Flash is about 7.5x Haiku's price per token), the API's estimate is $1.14 (range to $2.28), cap $2.50; experiment `e_0mw3bbbba86e8364652ebd85f`, 20 of 20 answered and passed, 0 infra | 20 | $0.259 | Rishi, "As planned: 20 trials" after the correction |
| 5 Nov | Judge retest (planned 14:26): Gemini 3.8 Flash re-judges the same 33 discovery outputs to measure its consistency with itself; expected about $0.26, within the existing $1 approval | 33 calls | $0.249 | Rishi, "Approve both" |
| 5 Nov | Positive control (started): calculators down vs the full toolset, Hermes with Claude Haiku 5.5, prompt v1, all 21 tasks x 5 x 2; estimate $2.10 (range $1.05 to $4.20), cap $5; `e_0mw3cb6519603428c4ce9bcad`, 210 of 210, 0 infra | 210 | $2.299 | Rishi, "All 8 calculators down" (about $2.30, cap $5) |
| 5 Nov | Cross-harness replication (started): own loop v1 vs v2, held-out 10 x 10, Claude Haiku 5.5; estimate $1.26 (to $2.53), cap $3; `e_0mw3cy22s7dd697c36b50430d`, 200 of 200, 0 infra | 200 | $2.114 | Rishi, "Both own loop and LangGraph" |
| 5 Nov | Cross-harness replication (started): LangGraph v1 vs v2, held-out 10 x 10, Claude Haiku 5.5; estimate $1.87 (to $3.74), cap $4; `e_0mw3cy2930970251621fd47f3`, 200 of 200, 0 infra | 200 | $2.216 | same |
| 5 Nov | Video rehearsal (Rishi: "small real run for the video, go ahead", about $0.25, cap $1): Hermes vs own loop, prompt v1, Claude Haiku 5.5, 5 held-out tasks x 2; API estimate $0.22 ($0.11 to $0.43); `e_0mw3gy7nn88b5775090edfc16`, 20 of 20, 0 infra | 20 | $0.172 | Rishi |
| 5 Nov | Skills demo (Rishi: "Full demo", about $0.30, cap $1): Hermes, prompt v2, Claude Haiku 5.5, skills off vs on with the balance-transfer playbook, 3 tasks x 4; API estimate $0.21 ($0.11 to $0.42); `e_0mw3hq8zn8cdc95c5345b0fd6`, 24 of 24, 0 infra | 24 | $0.110 | Rishi |
| 5 Nov | Judge panel (D71 to D74): Gemini 3.8 Flash, Claude Sonnet 5.5 and Claude Haiku 5.5 on the 33 tuning trials (rubrics v1 and v2), then the dev set (v3 and v4) and all 40 held-out trials (v2, and the frozen v4); about $0.03 a trial for the three; expected $4 to $5, one LiteLLM key capped at $8 | 6 judgings of 33 to 40 trials by 3 judges | $5.89 (LiteLLM's spend for the panel key `judge-panel-d71`, read 6 Nov) | Rishi, "Go, as described" |
| 5 Nov | Open-weight check: own loop on the local Qwen2.5 7B (Ollama, priced at 0), 2 single-message tasks x 1; the first try (`e_0mw3bp0xh198a4e7c959ba244`) stopped on a config error and was cancelled, the second (`e_0mw3gbt9d38648a872d3c4b8b`) ran 2 of 2 | 3 | $0 (local, CPU time only) | Rishi, local Ollama |
| 6 Nov | Held-out re-judge with the hardened judge framing (framework 0.7.0, review G5): the same 40 held-out trials, the same three judges and frozen rubric v4, before any held-out label; on the panel key, capped by its remaining $2.11 | 120 judge calls (3 errors) | $1.35 | Rishi, "yes re-judge the held-out with the new framing" |
| 6 Nov | Haiku soak test (will it hold up in real use?): five experiments at once on a fresh clone at `ac089f8` (compose project `soak`, torn down after), all five harnesses on Claude Haiku 5.5, with seven injected faults (two API restarts, two worker kills, LiteLLM and Postgres each stopped for 10 s, a pause and resume); budgets totalling $29.90 under a hard cap of $30, expected about $11; 986 of 988 slots done, 2 lost to the soak's first finding (`docs/destructive-review.md`) | 999 attempts | $11.110 for trials (LiteLLM's spend log; the API recorded $11.099, the gap is the soak's second finding), plus $0.054 for two conflict checks on the soak's own database | Rishi, "~1,000 trials" ("Just run haiku") |
| 6 Nov | Dealbreaker, a prompt-axis positive control (D78): finance-advisor-skip-tools v1 (a planted defect) vs v2, Hermes, Claude Haiku 5.5, held-out 10 x 10; API estimate $2.01 ($1.01 to $4.03), limit $10; `e_0mw4mta9bbe283aef553ba013`, 200 of 200, 0 infra | 200 | $2.050 | Rishi, "Also run skip-tools" (about $2.30, limit $4, then "make the limit 10 $ and crack on") |
| 6 Nov | Video rehearsal 2: the dealbreaker vs v2, Hermes, Claude Haiku 5.5, 3 held-out tasks x 2 (loan-to-clear-card, prepay-personal-loan, otp-scam), to time the video's live run; API estimate $0.05 ($0.03 to $0.10), limit $1; `e_0mw4on9yw74bc56462120d4ec`, 12 of 12 in 2.5 min, 0 infra | 12 | $0.051 | D80 (under $5, no sign-off needed) |

**Total to 6 Nov: $33.25 in model calls** across the runs above (the two final runs $4.25, the positive control $2.30, the two cross-harness replications $4.33, the video rehearsal $0.17, the skills demo $0.11, the judge panel $5.89 and its held-out re-judge $1.35, the Haiku soak $11.11, the dealbreaker run $2.05, the second video rehearsal $0.05), plus $0.1521 for six conflict checks (System calls, below: $0.0183 on 4 Nov, and $0.053 for the headline's two configs, checked after the run on 6 Nov; $0.0265 for the dealbreaker's config; and $0.054 for two on the soak's own database, not in that table) and about $0.14 of GCP time for the clean-machine test.

Per trial on Haiku 5.5: a single question cost $0.0024 to $0.0035 (3 model calls); a 3-turn simulated-client conversation cost $0.012 to $0.014 (8 to 10 agent calls plus the simulator's).

## Clean-machine test (5 Nov)

One GCP VM for the final fresh-clone test, approved by Rishi ("Yes, today"; "dont give me a bill
shock"): e2-standard-4 in asia-south1 with an 80 GB balanced disk, about $0.17 an hour, created with
`--max-run-duration=4h --instance-termination-action=DELETE`, so Google deletes the VM and its disk
after 4 hours at most: about $0.70 at worst. No static IP, no GPU, no keys on the machine. Created
only when the code to test is merged; deleted by hand as soon as the test ends. It ran for 48
minutes (06:17 to about 07:05 IST) and was deleted by hand; its cost is in the table above.

## System calls

Model calls the platform makes itself, outside any trial (D38). Today there is one kind: the pre-run prompt conflict check (`POST /api/configs/:hash/conflict-check`) on Claude Sonnet 5.5, paid from a standing **$2 allowance** (`EVALS_CONFLICT_CHECK_ALLOWANCE_USD`). Anything beyond it still needs a sign-off (R8).

- **Each conflict check is appended here with its cost.** The API records every call in its `system_spend` table, with the cost and tokens from LiteLLM's spend log, and shows the total as its own line in `GET /api/spend`, apart from trial spend. After a check, run `python3 scripts/log_system_spend.py` (add `--api http://127.0.0.1:3001/api` on a non-default port): it appends each settled call not yet in the table below, so running it twice adds nothing. A cached check makes no call and adds no row. A failed call that still cost money is recorded too.
- **Per check:** about 4,000 characters of checker prompt plus the rendered prompt and settings (about 7,500 on Hermes with `finance-advisor.v1`), roughly 3,300 to 3,700 input tokens, and up to 6,000 output tokens including thinking (`max_tokens`, raised from 2,000 in `3a1d009`). On Claude Sonnet 5.5 that is at most about $0.07 to $0.08 a check; the three checks run so far cost $0.018 to $0.030 (table below), so the $2 allowance covers roughly 60 or more. Since D75 (6 Nov) the check runs on Claude Sonnet 5.5 when its key is set, otherwise on the checked agent's own model (or on `EVALS_CONFLICT_CHECK_MODEL`), at that model's price. The API holds that worst case against the allowance before each call and refuses with 402 once it could pass $2.
- **Note to Rishi at half:** `GET /api/spend` sets `half_reached` once $1 is used.
- Probe trials, which render a config's prompt for the check, run on the fake model and cost nothing real; their made-up fake cost is in neither line.

<!-- system-calls:start -->
| Date | Id | Kind | Model | Ref | Status | Input tok | Output tok | Cost | Source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-04 | `ss_0mw2514q91eea4107aead` | conflict_check | claude-sonnet-5-5 | config a54a75646e13 | done | 3,596 | 1,109 | $0.0183 | spend_log |
| 2026-11-05 | `ss_0mw45wvwp346e1b3cfcd7` | conflict_check | claude-sonnet-5-5 | config 9051fae02f4c | done | 3,418 | 1,658 | $0.0234 | spend_log |
| 2026-11-05 | `ss_0mw45xa13973b1bde4446` | conflict_check | claude-sonnet-5-5 | config d46271c1b43f | done | 3,717 | 2,232 | $0.0298 | spend_log |
| 2026-11-06 | `ss_0mw4mpb5bf9e82d446dc8` | conflict_check | claude-sonnet-5-5 | config 733aea59eaed | done | 3,526 | 1,949 | $0.0265 | spend_log |
<!-- system-calls:end -->
