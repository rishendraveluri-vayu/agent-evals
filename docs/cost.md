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

These are assumptions until the pilot replaces them: 8 LLM calls per trial, 8k input and 300 output tokens per call, no caching. That is 64k input and 2.4k output per trial.

| Model | Input $/MTok | Output $/MTok | $/trial | 400 trials | Price source |
| --- | --- | --- | --- | --- | --- |
| Opus 5.5 | 4.00 | 20.00 | 0.304 | $122 | Claude docs |
| Sonnet 5.5 | 2.00 | 10.00 | 0.152 | $61 | Claude docs |
| Gemini 3.8 Flash | 0.75 | 3.75 | 0.057 | $23 | Google AI Studio pricing page, checked 4 Nov (paid tier; cache read 0.075) |
| gpt-oss-120b | 0.15 | 0.60 | 0.011 | $4.40 | BenchLM, read 20 Oct, third-party |
| Haiku 5.5 | 0.10 | 0.50 | 0.0076 | $3 | Claude pricing page, checked 4 Nov (prompts up to 100k tokens; cache write 0.125, read 0.01; 5x above 100k) |
| GPT-6 Luna | 0.10 | 0.50 | 0.0076 | $3 | Costbench, as of 10 Oct, third-party |

- 400 trials is 20 tasks × 2 configs × N=10, used as a placeholder until the pilot sets N.
- Sonnet vs Gemini Flash at 200 trials each: about $42.
- Judge estimate (D45, Gemini 3.8 Flash): 3k input and 300 output per call is about $0.0034, before any thinking tokens; 60 labelled trials × 3 repeats is about $0.61. On Sonnet 5.5 it would be about $0.009 a call.
- Check third-party prices on the provider pages before quoting them. Gemini 3.8 Flash is listed to rise to $1.50 / $7.50 from 1 Jan 2027.

Sources:

- [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Costbench: Gemini vs OpenAI](https://www.costbench.com/compare/google-gemini-api-vs-openai-api/)
- [BenchLM: OpenRouter](https://benchlm.ai/hosts/openrouter)

## Ways to reduce cost

Fill in with what we actually tried and measured.

- Provider prompt caching. Fine for independence, because the model still generates a new answer. It is off in every config since D31 so that harnesses compare like for like; before that, Hermes's cached trials paid about a quarter of list price for input (above). Turning it on for every harness at once would cut cost without tilting a comparison.
- Fewer tools per config, since default toolsets cost about 3x the minimal set per call.
- Early stopping when the outcome is already clear, with the stopping rule set in advance.
- Sampling tasks or trials, with the effect on confidence stated.
- Batch APIs for the judge. Claude lists a 50% batch discount.
- Not LiteLLM response caching for trials, because repeats would stop being independent.

## Actual spend

The pilot, the experiment and the judge go here too (SP8), with their tokens per trial.

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

Per trial on Haiku 5.5: a single question cost $0.0024 to $0.0035 (3 model calls); a 3-turn simulated-client conversation cost $0.012 to $0.014 (8 to 10 agent calls plus the simulator's).

## Clean-machine test (planned, 5 Nov)

One GCP VM for the final fresh-clone test, approved by Rishi ("Yes, today"; "dont give me a bill
shock"): e2-standard-4 in asia-south1 with an 80 GB balanced disk, about $0.17 an hour, created with
`--max-run-duration=4h --instance-termination-action=DELETE`, so Google deletes the VM and its disk
after 4 hours at most: about $0.70 at worst. No static IP, no GPU, no keys on the machine. Created
only when the code to test is merged; deleted by hand as soon as the test ends. Actual cost goes in
the table above.

## System calls

Model calls the platform makes itself, outside any trial (D38). Today there is one kind: the pre-run prompt conflict check (`POST /api/configs/:hash/conflict-check`) on Claude Sonnet 5.5, paid from a standing **$2 allowance** (`EVALS_CONFLICT_CHECK_ALLOWANCE_USD`). Anything beyond it still needs a sign-off (R8).

- **Each conflict check is appended here with its cost.** The API records every call in its `system_spend` table, with the cost and tokens from LiteLLM's spend log, and shows the total as its own line in `GET /api/spend`, apart from trial spend. After a check, run `python3 scripts/log_system_spend.py` (add `--api http://127.0.0.1:3001/api` on a non-default port): it appends each settled call not yet in the table below, so running it twice adds nothing. A cached check makes no call and adds no row. A failed call that still cost money is recorded too.
- **Per check (estimate, not yet run):** about 4,000 characters of checker prompt plus the rendered prompt and settings (about 7,500 on Hermes with `finance-advisor.v1`), roughly 3,300 input tokens ($0.007), and up to 2,000 output tokens including thinking ($0.02): at most about $0.03, typically less, so the $2 allowance covers roughly 60 to 100 checks. The API holds that worst case against the allowance before each call and refuses with 402 once it could pass $2.
- **Note to Rishi at half:** `GET /api/spend` sets `half_reached` once $1 is used.
- Probe trials, which render a config's prompt for the check, run on the fake model and cost nothing real; their made-up fake cost is in neither line.

<!-- system-calls:start -->
| Date | Id | Kind | Model | Ref | Status | Input tok | Output tok | Cost | Source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-04 | `ss_0mw2514q91eea4107aead` | conflict_check | claude-sonnet-5-5 | config a54a75646e13 | done | 3,596 | 1,109 | $0.0183 | spend_log |
<!-- system-calls:end -->
