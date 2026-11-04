# Cost

Required by the brief: cost per experiment as a formula, actual spend from the experiment, and how to reduce cost.

## Formula

```text
cost = tasks × trials × configs × avg LLM calls per trial
       × (avg input tokens × input price + avg output tokens × output price)
       + judged trials × judge cost per call
```

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
- Judge estimate: 3k input and 300 output per call on Sonnet is about $0.009. 60 labelled trials × 3 repeats is about $1.60.
- Check third-party prices on the provider pages before quoting them. Gemini 3.8 Flash is listed to rise to $1.50 / $7.50 from 1 Jan 2027.

Sources:

- [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Costbench: Gemini vs OpenAI](https://www.costbench.com/compare/google-gemini-api-vs-openai-api/)
- [BenchLM: OpenRouter](https://benchlm.ai/hosts/openrouter)

## Actual spend

Fill in during SP8.

| Run | Model | Trials | Avg input tok/trial | Avg output tok/trial | Spend |
| --- | --- | --- | --- | --- | --- |
| Pilot | | | | | |
| Experiment | | | | | |
| Judge | | | | | |

## Ways to reduce cost

Fill in with what we actually tried and measured.

- Provider prompt caching. Fine for independence, because the model still generates a new answer.
- Fewer tools per config, since default toolsets cost about 3x the minimal set per call.
- Early stopping when the outcome is already clear, with the stopping rule set in advance.
- Sampling tasks or trials, with the effect on confidence stated.
- Batch APIs for the judge. Claude lists a 50% batch discount.
- Not LiteLLM response caching for trials, because repeats would stop being independent.

## Actual spend

| Date | Run | Trials | Spend | Signed off |
| --- | --- | --- | --- | --- |
| 4 Nov | First real-model smoke on Claude Haiku 5.5, 5 harnesses × 3 trials (`runs/20261104T083111Z-real`) | 15 | $0.077 (LiteLLM's records) | Rishi, R8, estimate $0.20, cap $3 |
| 4 Nov | Two earlier attempts that never reached a model: a script path bug, then an unscoped API key rejected with a 400 | 6 | $0.00 | same |
| 4 Nov | client-sim v2 check through the engine: 3 conversation trials on Haiku 5.5 (own loop, Hermes, LangGraph), experiment `e_0mw22cinx2dade03d979bb3c4` | 3 | $0.039 | Rishi, D27 ("I'll show you 3 transcripts from v2") |
| 4 Nov | client-sim v3 check through the engine: 3 conversations on Haiku 5.5; every simulator reply came back empty (300-token cap used up by thinking), fix in progress | 3 | $0.013 | Rishi, D30 |
| 4 Nov | First Gemini 3.8 Flash trial (own loop, single question): one call took 3 minutes and the next got a 503 "high demand" after the 240 s timeout | 1 | $0.007 | Rishi, R8 (the approved 30-trial smoke) |

Per trial on Haiku 5.5: a single question cost $0.0024 to $0.0035 (3 model calls); a 3-turn simulated-client conversation cost $0.012 to $0.014 (8 to 10 agent calls plus the simulator's).

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
