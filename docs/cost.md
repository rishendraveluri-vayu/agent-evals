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
| Gemini 3.8 Flash | 0.75 | 3.75 | 0.057 | $23 | Costbench, as of 10 Oct, third-party |
| gpt-oss-120b | 0.15 | 0.60 | 0.011 | $4.40 | BenchLM, read 20 Oct, third-party |
| Haiku 5.5 | 0.10 | 0.50 | 0.0076 | $3 | Claude docs |
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
