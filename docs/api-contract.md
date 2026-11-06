# Control-plane API contract (SP2, SP3, SP7)

Status: 4 Nov 2026. Built on R14 (data model) and D2 (workers only claim and report over HTTP).
Three streams build against this file in parallel: the NestJS API, the Python worker, and the
Vue UI. Change it only by editing this file in the same commit as the code.

**As built (4 Nov):** every path below is served under `/api` (a worker calls `POST /api/worker/claim`). Each attempt is its own trial row with its own id, so a re-queued attempt gets a new `trial_id`; its folder is `runs/<experiment_id>/<trial_id>/attempt-<n>/`, which only the API writes, from the files the worker uploads (workers mount no `runs/`). A config's model and price are looked up with LiteLLM's `/model_group/info`, because `/model/info` expands the `fake/*` wildcard into about 220 names and never lists `fake/*` itself; `POST /configs` returns 400 `unknown_model` for a model LiteLLM does not serve. Experiment trials' spans come back in the raw OpenTelemetry shape. A report whose file hashes do not match is accepted and flagged, not refused. Shared request and response types: `apps/api/src/contract.ts`.

All bodies are JSON. Times are RFC 3339 UTC. Money is USD as a number. Hashes are
`sha256:<hex>`; every hash the API takes in, a worker's report included, may also be bare hex
(any case), and the API stores and returns it as `sha256:<hex>`. Errors are `{"error": "<code>", "message": "<plain words>"}` with a 4xx/5xx
status, plus `"fix": "<what to change>"` where the API can say how to put the request right
(every refused setting on `POST /configs` has one; so do the experiment refusals below). The trial spec, result, span and runner-report shapes are contract v2
(`contract/v2/*.schema.json`); this API carries them unchanged.

## Who holds which secret

- **The API alone holds `LITELLM_MASTER_KEY`.** It mints each trial's LiteLLM keys at claim
  time (agent key, plus a simulator key when the task has a client simulator), each limited
  to that trial's model and given a budget, and revokes them when the trial is reported or
  its claim lapses. Workers never see the master key, so nothing an agent runs can read it
  (R10.3 tightened; D2). For a call the platform makes itself (the conflict check, D38) it
  mints a key for that one call, limited to the checker model with a $0.10 budget, makes the
  call with that key (never the master key), and revokes it straight after.
- **The LLM judge's key (SP4, R8).** Judging costs real money, so it runs only for an experiment
  Rishi has approved with a model and a budget (`POST /experiments/:id/judge`, below). The API
  mints one key for that experiment's judging, limited to that model, capped at that budget and
  outside the experiment's team (so judging never spends the trials' budget), and hands it to
  the grader worker in each grading claim for that experiment's trials. It is kept in
  `judge_approvals`, because every claim hands it out again; no UI-facing route returns it.
  Revoking deletes it in LiteLLM, so it stops working at once.
- **Provider keys (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`) are LiteLLM's alone.** The API gets
  one flag per key instead (`ANTHROPIC_KEY_SET`, `GEMINI_KEY_SET`: `1` or empty), so `GET
  /models` can say which models cannot run yet; `scripts/check_compose.py` fails if any other
  service would receive a key's value.
- Workers hold only a worker token (`EVALS_WORKER_TOKEN`), sent as `Authorization: Bearer`.
  Provider keys live only in LiteLLM.

## Catalogue (read by the UI, files in git are the source)

| Method and path | Returns |
| --- | --- |
| `GET /harnesses` | `[{name, package, ref, python, capabilities}]`, one per `workers/*/src/*/capabilities.json` (read-only mount). A harness `make new-harness` made and nobody finished, whose `version.package` or `version.ref` is still the scaffold's `"TODO"`, is left out (since 5 Nov, review A2): its adapter is a stub and no worker claims its trials. |
| `GET /prompts` | `[{id, version, sha256, path, text}]` from `configs/prompts/<id>.<version>.md` (the leading `<!-- -->` review header stripped, as `prompt_text` does). |
| `POST /prompts` | `{id, base_version, text}` writes the next version of an existing prompt and returns `{id, version, sha256, path}` (below). |
| `GET /toolsets` | `[{id, version, sha256, servers: [{name, allowed_tools}], manifest: [{server, server_version, tools: [{name, description, input_schema}]}], description, validation_only}]`. Two built-in toolsets, in this order. First `finance/v3` (since 5 Nov): the 11 finance tools, the 7 arithmetic tools (`add`, `subtract`, `multiply`, `divide`, `percent_of`, `percent_change`, `round`; D54) and `reference_rates` (D58) at server 0.4.1; being first, it is the new-config default and the builder's choice. Then `finance-no-calculators/v3` (5 Nov, D70), `validation_only: true`: the same server and version with the eight calculators left out (`calculate_emi`, `amortization_schedule`, `prepayment_impact`, `debt_payoff_plan`, `sip_future_value`, `fd_maturity`, `inflation_adjusted_value`, `loan_affordability`), so 11 tools, as if the calculator service were down. It is for the positive control only: the builder never gives it to an agent, a new config never starts on it (not even one copied from a config that has it), and the Config screen offers it in the toolset list as "(validation only)" with its description; a fork of a config that has it keeps it. `description` and `validation_only` are words for people, outside the hash. `finance/all` (the 11 tools, server 0.2.0 and earlier) and `finance/v2` (the 18, server 0.3.0) are no longer listed; configs and trials that used them keep their row and hash, and a fork of one is moved to `finance/v3` with a note. A change to the tools is a new version, never an edit of a listed one (a unit test pins each version's hash). `sha256` is the canonical JSON hash of `{id, version, servers, manifest}`, so it covers the allowed list, each allowed tool's description and input schema and the server's version, not just the names (since 4 Nov; configs made before keep their names-only hash). Pinned: `finance/v3` `sha256:8e0508d2…`, `finance-no-calculators/v3` `sha256:34e53515…`. |
| `GET /tasks` | `[{sha256, id, version, split, kind, summary, graders, problems}]` from `tasks/<id>/task.json`. `problems` lists, in words, why a task cannot be used (an empty list when it can): the fields below, and since 5 Nov (A5) each grader against the grader framework's schema, `graders/src/evals_graders/grader-spec.schema.json`, for example `graders[1].tolerence is not a field this grader type takes`, plus a grader id used twice. `POST /experiments` and the estimate refuse a task with problems (400 `invalid_task`, naming them). |
| `GET /models` | `[{name, provider, input_per_mtok, output_per_mtok, key_set}]` from LiteLLM's `/model/info`, real models only. `key_set` says whether the provider's key is in `.env` for LiteLLM: compose passes the API a flag per key (`ANTHROPIC_KEY_SET: ${ANTHROPIC_API_KEY:+1}`, likewise `GEMINI_KEY_SET`), `1` when set and empty when not, never the key. It is `null` when the API was not told (the flag is absent, as outside compose) and for a provider it has no flag for (`gemini` and `vertex_ai` read the Gemini flag). |

**New prompt version** (`POST /prompts`, for the UI's prompt editor). The API writes
`configs/prompts/<id>.v<n>.md`, where `n` is the highest `v<number>` version of `id` plus one
(versions that are not `v<number>` are not counted). The file starts with a review header in the
existing files' style, which `GET /prompts` strips again:

```text
<!--
finance-advisor v2, created from v1 in the UI on 4 Nov 2026.
This header comment is stripped before use. Once a run has used this version, changes go in
a new version file.
-->

<text, trimmed>
```

`sha256` is that of the stripped text, as in `GET /prompts`, and the new version is stored at
once, so a config can point at it. The same text as an existing version of `id` (after trimming)
returns that version with 200 and writes nothing; a new file is 201. Posts run one at a time.
The compose file mounts `configs/prompts` read-write over the read-only `configs/`, so it must be
writable by uid 1000 on the host. The API does not commit the file: it is in the working tree until
someone commits it, and the database keeps the text by its hash either way. Refusals, each with a
`fix`:

| `error` | When |
| --- | --- |
| `invalid_prompt` (400) | not an object; `id` or `base_version` with anything but letters, digits, `_` and `-` (so no `/`, `\` or `..`); an empty `text` |
| `unknown_prompt_id` (400) | no `configs/prompts/<id>.*.md`: only existing prompts get new versions |
| `unknown_base_version` (400) | `base_version` is not a version of `id` |
| `prompt_too_large` (400) | `text` over 50 KB (51,200 bytes in UTF-8) |
| `prompt_text_exists` (409) | the text is already a version of another prompt id (the prompts table is keyed by text hash) |
| `prompt_version_exists` (409) | the next file appeared between the listing and the write; it is never overwritten (`wx`), so post again |

**Task file, minimum the engine needs** (`tasks/<id>/task.json`). The task format is
**[Rishi designs]** in SP4; this is only what the engine reads, and everything else is kept
and passed through unread:

```json
{"id": "debt-regret-04", "version": "1", "split": "discovery",
 "messages": [{"role": "user", "content": "..."}],
 "client_sim": null,
 "client_state": "client.json",
 "graders": []}
```

`graders` is a list of grader specs, each checked against the grader framework's schema
(`graders/src/evals_graders/grader-spec.schema.json`, the file the grader itself validates
against; the API image copies it to the same path under `/repo`) when the task is read, so a typo
is a task problem in `GET /tasks`, not an `error` grade after the trial has run (since 5 Nov, A5).
If the API cannot load that schema, every grader is a problem ("cannot be checked"), never a pass.
A regex that Python cannot compile, a missing `unit_test` file and a missing rubric are still found
only at grading time.
An optional `required_tools` (finance tool names, such as `["calculate_emi"]`) is copied into
the spec's `task.required_tools`, a grader primitive: the runner's `checks.json` records which
were called (docs/adapter-contract.md section 12). A name the finance server does not have, or a
repeated one, is a task problem.
`client_sim` is contract v2's object without `model` (the experiment supplies the simulator
model) and without `client_summary` (the API builds it). `client_state` names a file next to
`task.json` that the runner places in the trial's state folder for the finance MCP server. For a
simulated-client task the API also summarises that file (profile and debts) into the spec's
`client_sim.client_summary`, so the simulator never contradicts what the tools return (D27).

## Configs

- `POST /configs` with `{name, harness, model, prompt_sha256, toolset_sha256, settings, harness_options, seed, parent_hash}`.
  `parent_hash` (optional, D34) names the config this one was forked from: it must exist (400
  `unknown_parent`), and a fork identical to its parent is a 400 `same_as_parent` ("change the one
  thing this fork is meant to test"). Lineage is not behaviour, so it is not in the hash; the
  first post of a config's content records its parent, and a later post of the same content keeps it.
  The API checks every set setting against the harness's capabilities (an unsupported one
  is a 400 `unsupported_setting` naming it) and against the model (D25): a setting the model
  refuses is a 400 `unsupported_setting` naming the model. The table of refused settings is
  `MODEL_REJECTS` in `apps/api/src/configs/settings.ts`; today it holds one entry,
  `claude-haiku-5-5` refuses `temperature` (the provider's 400 "`temperature` is deprecated for
  this model", 4 Nov). It then fills every setting the config leaves out (or sets to null), with
  its source in `settings_sources`:

  | Setting | Left unset | Source |
  | --- | --- | --- |
  | `temperature` | `null`: not sent, so the harness's or provider's default applies (D25) | `harness_default` |
  | `parallel_tool_calls` | `false`: off by default (D19; D25 covers sampling settings only) | `platform_default` |
  | `max_output_tokens` | 8192 | `platform_default` |
  | `max_steps` | 15 | `platform_default` |
  | `timeout_s` | 300 | `platform_default` |
  | `memory`, `skills`, `compression` | `{"enabled": false}` | `platform_default` |
  | any setting the harness cannot take | `null` | `unsupported` |
  | any setting the model refuses | `null`, never a platform default | `harness_default` |

  **Seeds (D39).** `seed` (optional) is the state every trial of the config starts with, in
  contract v2's seed shape (`contract/v2/spec.schema.json`, `seed`):
  `{"memory": ["a fact", ...], "skills": [{"name", "description", "body"}]}`. Either list may be
  left out (it is then empty); a skill name is lower-case letters, digits and hyphens, and two
  skills cannot share one. Config-given state only, never learned state (R10.8). The claim copies
  it into the trial's `spec.seed`, which the adapter writes natively (Hermes: `memories/MEMORY.md`
  and `skills/<name>/SKILL.md`). Refusals, each with a `fix`:

  | `error` | When | `fix` |
  | --- | --- | --- |
  | `invalid_seed` | not the seed shape (an unknown key, an empty memory entry, a bad skill name, two skills with one name) | the shape to send |
  | `unsupported_seed` | a non-empty list for a feature the harness cannot take (capabilities, as for settings) | "ownloop has no memory to seed: remove seed.memory, or pick a harness that takes it (hermes)." |
  | `seed_feature_off` | a non-empty list while the config's resolved setting turns the feature off (memory and skills are off unless set) | "Set settings.memory to {"enabled": true}, or remove seed.memory." |

  It then computes
  `hash = sha256(canonical JSON of harness ref, adapter version, capabilities sha256, model,
  prompt sha256, toolset sha256, settings, harness_options, seed)`. An empty seed (both lists
  empty, or `seed` left out) is left out of the hashed JSON, so a config without seeds keeps the
  hash it had before seeds existed, and any seed gives a different hash. Memory entries keep
  their order, and so do skills. Posting the same content twice returns the same config (200,
  not a duplicate).

  **Refusals carry a fix** (D25 follow-up, Rishi's guide review item 1). Every 400 for a refused
  setting has a `fix` the Config screen shows by the field:

  | `error` | When | `fix`, for example |
  | --- | --- | --- |
  | `unsupported_setting` | the model refuses it | "Claude Haiku 5.5 rejects temperature: leave it unset, or pick a model that takes it." |
  | `unsupported_setting` | the harness cannot take it (the message quotes the capabilities file's reason) | "ownloop ignores memory: leave it unset, or pick a harness that takes it (hermes)." |
  | `invalid_setting` | a bad value | "Set max_steps to an integer of at least 1, or leave it unset for the default." |
  | `unknown_setting` | a name that is not a setting | "Did you mean temperature? Rename temprature to temperature." |
  | `invalid_harness_options`, `unknown_harness`, `unknown_model`, `unknown_prompt`, `unknown_toolset` | | where to pick a valid one |
  | `harness_not_implemented` | the harness is scaffolded, not implemented: its capabilities file still has the scaffold's `"TODO"` version (since 5 Nov, A2) | "Finish it first (workers/crewai/README.md): write setup and run_turn, run probe.sh, set version.package and version.ref in its capabilities.json, and add its worker to docker-compose.yml. Until then pick a harness from GET /harnesses: ..." |

  **Warnings** (valid but risky, stored anyway): `warnings: [{code, message, fix}]`. Today one
  code: `langgraph_model_name_rewrite`, for a LangGraph config whose model name langchain-openai
  1.7.2 rewrites the request for (`workers/langgraph/README.md`, finding 6): names starting
  `gpt-5` (without `chat`) drop any temperature but 1; `o1` names send temperature 1 when unset;
  `^o\d` names send the system prompt as `developer`; `gpt-6` and `codex` names would move to the
  Responses API, which the adapter turns off (`use_responses_api=False`), so for those two the
  warning asks for the captured request to be checked. The message starts "LangGraph changes the
  request for this model name"; the fix is to serve the model under another LiteLLM name, or to
  run it on another harness.

  **Ignored settings:** `unsupported: {<setting>: <reason>}` lists every setting this harness or
  model ignores, for the UI to grey out with the reason: the harness's own words from its
  capabilities file ("langgraph does not support skills: LangGraph has no skills"), or the
  model's refusal ("Claude Haiku 5.5 rejects temperature, so it is not sent and the provider's
  default applies").
- `GET /configs`, `GET /configs/:hash` return `{hash, name, harness, harness_ref, model,
  prompt, toolset, settings, settings_sources, unsupported, warnings, harness_options, seed,
  parent_hash, example_only, created_at}`; `seed` always has both lists, empty when nothing is seeded. `unsupported` and `warnings` are worked out from the stored
  capabilities, so every read has them, not only the POST. `GET /configs/:hash` adds
  `children: [{hash, name, created_at}]`, the configs forked from it, oldest first.
  `example_only` (since 5 Nov) is true when the config came with a shipped example (an example
  experiment uses it, or it is the parent, at any depth, of one that does) and no experiment of
  this database's own uses it, unstarted and discarded ones included. Such a config was made
  elsewhere with the files of its day: its prompt or toolset may not be in `GET /prompts` or
  `GET /toolsets`, so the UI does not start a new config or a run from it unless asked to.
- `GET /configs/:a/diff/:b` returns `[{path, a, b}]`: every field that differs (`unsupported`,
  `warnings`, `parent_hash` and `example_only` are left out: derived, or not behaviour). Seeds show as
  `seed.memory` and `seed.skills`, each list compared whole.

## Pre-run checks: rendered prompt and conflict check (D33, D38)

Harnesses such as Hermes wrap our task prompt in text of their own (harness guide 3.3), and ours
can quietly contradict it. Before a run, a config's screen shows the full system prompt the
model gets and a list of contradictions. Types: `RenderedPromptView`, `ConflictCheckView` in
`apps/api/src/contract.ts`.

### Rendered prompt

- `POST /configs/:hash/rendered-prompt` makes sure the config has a rendered prompt.
  - Stored already (one per config hash, never re-made): 200, `status: "ready"`, `cached: true`.
  - Otherwise, if the config has no probe trial yet, or its last probe gave no prompt, the API
    queues a **probe trial** and answers 202 with `status: "queued"`. While a probe is queued
    or running, a POST answers 202 with that probe (`queued` or `running`); there is at most one
    live probe per config, so a second click queues nothing.
  - Once the probe has reported, the next call reads the prompt from it: 200 with `status:
    "ready"`, `cached: false` (stored from then on), or `status: "failed"` with `error` saying
    why, in which case a POST queues a new probe.
- `GET /configs/:hash/rendered-prompt` returns the same view without starting anything;
  `status: "none"` before the first probe. The UI polls this one.
- Body: `{config_hash, status, probe: {trial_id, status, label, model} | null, cached, error,
  rendered}` where `rendered` is null until ready, then:

  | Field | Meaning |
  | --- | --- |
  | `system_text` | The system message of the probe's stored first request (`artifacts/proxy/0001.request.json`, written from LiteLLM's spend log, so exactly what the model received). Several leading system messages are joined by a blank line. Normalised the way `evals_adapter.invariance.normalise` does: Hermes's `Conversation started: ...` line becomes `Conversation started: <date>`, and every mention of the probe model (Hermes's `Model:` line) becomes `<model>`. |
  | `sha256` | Of `system_text`. The conflict-check cache keys on it. |
  | `tools` | Tool names in the request's order, e.g. `mcp__finance__calculate_emi`. |
  | `ours` | `{start, end}`: our task prompt's place in `system_text`, as JavaScript string indices (UTF-16 code units), end exclusive. It is found verbatim, then without its trailing newline. Null if not found. |
  | `harness_text` | `system_text` with our prompt replaced by `<<OUR TASK PROMPT>>`: the harness's own text, and where ours sits in it. Equal to the marker alone when the harness adds nothing (own loop, Agents SDK). |
  | `normalised`, `caveats` | What was normalised, and why the text may differ from what the real model gets (see below). |
  | `trial_id`, `created_at` | The probe it came from; `GET /trials/:id` shows its trace. |

- **A probe trial** runs the config once through the harness's own worker and the normal
  claim and report protocol, with exactly two changes: the model is `fake/finance-emi` (the
  fake model through LiteLLM, so it costs nothing real; its key is limited to that model with a
  $0.50 budget of made-up fake money), and the task is the built-in `prompt-probe` task (one EMI
  question, no client file, not in `GET /tasks`). Its row has `probe: true` and
  `experiment_id: null`, it is stored under `runs/probes/<trial_id>/attempt-1/`, and it is
  claimed ahead of queued experiment trials for the same harness. It is never re-queued, never
  pauses anything, and is never counted in experiment results, estimates, the label queue or
  `trials_usd`.
- **Caveat on every rendered prompt:** text a harness adds only for some model names is
  missing, because the probe ran on the fake model. Hermes adds tool-use guidance for model
  names containing `gpt`, `gemini`, `qwen`, `deepseek` and a few others, and Google guidance for
  `gemini` (`agent/system_prompt.py:580`); a Hermes config on Gemini really gets more text than
  its rendered prompt shows (`docs/known-limits.md`).
- A probe that cannot give a prompt says why in `error`: it stored no first request (it never
  reached the model; its label and end state are named), the file is not intact or not JSON,
  LiteLLM cut the body short (`MAX_STRING_LENGTH_PROMPT_IN_DB`), the request has no system
  message, or the worker's lease lapsed.

### Conflict check

- `POST /configs/:hash/conflict-check` (200) checks our task prompt and the config's settings
  against the harness's own text. It needs a ready rendered prompt (409
  `rendered_prompt_required` otherwise).
  - **Input.** System message: the highest version of `configs/prompts/conflict-check.v<n>.md`
    (review header stripped). User message: `<harness_text>`, `<task_prompt>` and `<settings>`
    blocks (the config's resolved settings as JSON).
  - **Model (D75, 6 Nov).** `EVALS_CONFLICT_CHECK_MODEL` when set; else `claude-sonnet-5-5` unless
    the API knows its key is missing (`ANTHROPIC_KEY_SET` empty); else the config's own model, which
    any run of the config needs anyway. `GET /configs/:hash/conflict-check/model` returns
    `{config_hash, model, why}` without a call. A stored check of the same input counts whichever
    model made it (the cache prefers the model this setup would call), so adding a key later does not
    make a checked config pay again.
  - **Call.** The chosen model through LiteLLM's `/v1/chat/completions`, with a key the API
    mints for this call (model-limited, budget $0.10) and revokes after. `max_tokens: 6000` (since `3a1d009`; it was 2000);
    temperature is not sent and no thinking setting is sent, so the model's defaults apply
    (D38). Thinking counts towards `max_tokens`, so a long think can cut the reply short; that
    reply is refused, not repaired.
  - **Reply.** JSON only: `{conflicts: [{harness_says, we_say, why_it_matters, severity:
    high|medium|low}], notes}`. A code fence or prose around the object is tolerated; anything
    else (no object, no `conflicts` list, a missing field, another severity) is 502
    `checker_output_invalid`, recorded as spend and not cached, so the next POST calls again.
    A LiteLLM or provider error is 502 `checker_call_failed`, also recorded.
  - **Cache.** By (`input_sha256`, checker prompt sha256, model), where `input_sha256` hashes
    the rendered prompt's sha256, our prompt's sha256 and the settings: everything the checker
    is given. The same input never pays twice; a hit returns `cached: true` and makes no call.
    *Deviation from the brief, for Rishi:* the brief keyed the cache on the rendered prompt sha,
    checker version and model only. The settings are part of the checker's input, so two configs
    with the same rendered prompt and different settings (say `max_steps` 5 and 15) would
    otherwise share findings that name the other's settings.
  - **One at a time.** Only one check runs anywhere at once (a Postgres advisory lock); a
    second one meanwhile gets 409 `conflict_check_busy`, and on retry finds the cache. Two clicks
    never both pay.
  - **No harness text.** When `harness_text` is only the marker (the harness adds nothing), the
    answer is 200 with `skipped: "no_harness_text"`, no conflicts, `cost_usd: 0`, and no call.
    When our prompt was not found in the rendered prompt, 409 `task_prompt_not_located`.
  - **Allowance (D38).** Before the call the API reserves the check's worst case: input
    characters ÷ 2 as tokens at the input price plus 6,000 output tokens at the output price
    (about $0.07 to $0.08 today), at LiteLLM's prices for the model. If settled spend plus open
    reservations plus this one would pass the allowance (`EVALS_CONFLICT_CHECK_ALLOWANCE_USD`,
    default 2), the answer is 402 `allowance_exhausted`, and nothing is minted, called or
    recorded. A cached result is still returned, since it costs nothing.
  - **Spend.** Each call is one `system_spend` row (kind `conflict_check`): written `pending`
    with the reservation before the call, then settled with the cost and tokens from LiteLLM's
    spend log for the key (waiting up to 10 s for the row), else from the
    `x-litellm-response-cost` header (`cost_source` says which). A cost never reported stays
    null and its reservation keeps counting against the allowance.
- `GET /configs/:hash/conflict-check` returns the stored result for the config as it is now,
  without a call; 200 `null` before any (since 5 Nov; it was a 404, which logged an error on
  every visit to an unchecked config's page). 409 `rendered_prompt_required` as for the POST.
- Body: `{config_hash, rendered_sha256, input_sha256, checker: {id, version, sha256}, model,
  conflicts, notes, cost_usd, cached, skipped, spend_id, checked_at, allowance}`. `cost_usd` is
  what the check cost when it ran (also on a cached answer; `cached: true` means this request
  spent nothing). `allowance` is `{kind, limit_usd, used_usd, remaining_usd, calls,
  half_reached}`; `used_usd` counts settled costs and open reservations.

## Spend

- `GET /spend` returns `{trials_usd, trials_spend_unknown, fake_trials_usd, system_usd, judge_usd, judge_approvals, total_usd,
  system_by_kind: {<kind>: {usd, calls}}, allowances: [{kind, limit_usd, used_usd,
  remaining_usd, calls, half_reached}]}`. `trials_usd` includes abandoned attempts' spend, read
  by the lease sweep (worker protocol step 6, since 5 Nov, G3); `trials_spend_unknown` counts the
  abandoned attempts on a real model whose spend LiteLLM could not give, which `trials_usd` and
  `total_usd` therefore leave out (the header says so when it is above 0). `judge_usd` is the LLM judge's spend across every
  approval, revoked ones included: for each key, the sum of `spend` over its LiteLLM spend-log
  rows (for a revoked key, at least what the log showed at revoke, and that figure when LiteLLM
  cannot be read). It is null when an active key's log cannot be read. `judge_approvals` counts
  approvals ever made. `total_usd` is real trial, system and judge spend (the judge only when
  known), never fake prices. `trials_usd` is experiment trials' real spend: each trial's agent
  cost when its config's model is real, and its simulator cost when the experiment's simulator
  model is real. `fake_trials_usd` is the rest, the made-up prices LiteLLM counted for calls to
  `fake/*` models: not money, so kept apart and out of `total_usd` (since 5 Nov; before, it was
  in `trials_usd`). Probe trials and shipped examples are left out of both. Each experiment's own
  `spend_usd` still counts every call at its price, fake ones included, as LiteLLM's budget for
  it does. `system_usd` is the platform's own calls with a known cost, shown as its own line
  (D38).
- `GET /spend/system?kind=conflict_check` returns one row per platform-made call, newest first:
  `{id, kind, model, status: pending|done|failed, reserved_usd, cost_usd, cost_source, input_tokens,
  output_tokens, ref, error, created_at, settled_at}`. `ref` names what it was for
  (`config:<hash>`). `scripts/log_system_spend.py` appends the settled rows to `docs/cost.md`.

## Experiments

- `POST /experiments/estimate` with `{config_hashes, task_sha256s, n, sim_model,
  sim_prompt_sha256, parent_experiment_id, reuse_baseline}` returns `{trials, cost_usd:
  {expected, low, high}, minutes, basis, basis_detail, budgets, baseline}`. **From history
  (Rishi's guide review, item 8):** each config x task cell takes the mean tokens, cost and wall
  time of earlier finished trials (`done`, LiteLLM's record complete) of the same config and task
  (`source: config_task`), else of the same harness and model, any config or task
  (`harness_model`), and only with neither the `docs/cost.md` assumptions (`assumption`: 64k
  input, 2.4k output, 60 s per trial). The cost is LiteLLM's recorded mean cost where history has
  it, else tokens at LiteLLM's prices. The simulator's cost per trial comes from the same cell,
  else from earlier trials of the same task with the same simulator model, else the
  assumptions. **Time** divides each harness's trial time by its live workers (a worker is live
  if it asked for a trial, 204 included, or heartbeat in the last 60 s; none seen counts as one),
  harnesses in parallel; `basis_detail.workers` is `{<harness>: {live, used}}`. **A trial's time
  is its worker's whole slot, claim to report** (the mean of `finished_at - claimed_at`, since 4
  Nov): starting the trial process and the tool server, running it and uploading its files, not
  only the agent's own `wall_s`, which is used only for a trial with no claim time. On the 4 Nov
  fresh-clone QA the slot was 8.0 s against 3.5 s of agent time. With no history a trial takes
  60 s on a real model and `fake_wall_s_per_trial` (10 s) on a `fake/*` one, which answers at once
  (60 s made a 30-trial fake run's estimate 30 min against 4 min 13 s). Each cell's `wall_s` is
  that slot time. `basis` says all of this in words. No power estimate yet (the smallest
  difference a run can detect is not computed; docs/known-limits.md has the simulated power).
- `POST /experiments` with `{name, axis, config_hashes, task_sha256s, n, sim_model,
  budget_usd, plan_commit, sim_prompt_sha256, order_seed, futility, parent_experiment_id,
  reuse_baseline, calibration}` creates the experiment and all its trial rows
  (`queued`), records the platform commit, and sets a LiteLLM budget
  for the whole experiment. It returns the experiment. Nothing runs until it is started.
  **Platform commit (since 5 Nov, G2).** `EVALS_PLATFORM_COMMIT`, when set, is recorded as given,
  with `platform_commit_source: "env"`. Left blank (the default, so a plain `docker compose up`),
  the API reads the checkout's HEAD from its `.git`, which compose mounts read-only at
  `/repo/.git` (`EVALS_GIT_DIR` elsewhere), each time an experiment is created or estimated:
  a detached commit, or the branch HEAD names, from its loose ref file or `packed-refs`; no git is
  run. It is recorded with `platform_commit_source: "git"`. Either way the working tree is
  unknown-dirty: the API cannot see uncommitted changes, nor which commit the running images were
  built from. With neither, both fields are null (a copy without `.git`, a worktree whose git
  folder is outside the mount); so are an older experiment's source. The baseline decision (D34,
  below) compares the commit read the same way.
  `name` is trimmed and must be 1 to 200 characters (`EXPERIMENT_NAME_MAX`); a longer one is a 400
  `invalid_experiment` that says its length, with the fix "Shorten the name to 200 characters or
  fewer." (since 5 Nov, QA round 3; nothing is created).
  A config whose stored harness version is the scaffold's `"TODO"` (saved for a scaffolded harness
  before `POST /configs` refused one) is a 400 `harness_not_implemented`, here and on the estimate,
  since no worker would ever claim its trials (since 5 Nov, A2).
  `budget_usd` must cover the estimate's high end (400 `budget_below_estimate`, R10.6), **except
  for a run on fake models only**: when every model it calls (each arm's, and the simulator's when
  a task needs one) is `fake/*`, nothing real is spent and the prices are made up for testing, so
  it is never refused. Its budget is raised to the estimate's high end when below it, so neither
  LiteLLM's cap nor the spend guard can stop a free run part-way; the stored and returned
  `budget_usd` is the raised one. A fake agent with a real simulator model is checked as usual. The
  simulator prompt defaults to the highest version of `client-sim` (v2 since D27). The simulator
  runs at D22's temperature 0, except on a model that refuses temperature (Haiku 5.5), where its
  temperature is `null` and not sent (D27); the token cap is 2048, because Haiku 5.5's reasoning
  counts towards it (at 300 on 4 Nov it took the whole cap and the reply was empty). An
  experiment keeps the cap it was created with. `sim` in the experiment shows all three.
- **Plan commit.** `plan_commit` (here and on `start`) is the git commit of the analysis plan in
  `docs/experiment.md`: blank or null for none, else 7 to 40 hex characters (as `git rev-parse`
  prints it), trimmed and stored in lower case. Anything else is a 400 `invalid_plan_commit` with
  a `fix`; a value that is not a string is a 400 `invalid_experiment`. Only the format is checked:
  the API cannot see git history, so it records the commit as given and does not check that it
  exists or that it holds the plan.
- **Lineage and baseline reuse (D34).** `parent_experiment_id` (optional) names the experiment
  this one follows from (400 `unknown_parent_experiment` if there is none). With
  `reuse_baseline: true` (which needs a parent and two arms), arm A takes the parent's finished
  arm-A trials instead of running again, only when all of these hold: the parent's arm-A config
  hash is this arm A; the task hashes are the same set; both ran under the same, known platform
  commit; the simulator model and prompt are the same; and the parent has at least N `done`
  arm-A trials for every task (its own, or ones it reused itself). Then the first N per task (by
  repeat, then attempt) are recorded on arm A, nothing is copied, only arm B is queued, and the
  estimate and budget check cover arm B alone. Otherwise arm A is queued as usual. Either way a
  `baseline` event and `baseline: {applied, reason, reused_trials}` in the detail say which
  applied and why ("arm A runs again: the platform commit differs (parent old0000, now
  abc1234)"). A reused arm shows `status: complete`, `reused_from` and `reused_trials`, its
  counts are the reused trials, and compare's arm-A rows are those trials. The estimate endpoint
  takes the same two fields and returns `baseline` too. Reuse does not look at grading: the
  reused trials keep the grades they had, the comparison gives no verdict while a required
  grader's versions differ between the arms (D72, under Statistics below), and this experiment's
  regrade covers the reused trials too (Grading).
- **A/A calibration (D44, since 5 Nov).** `calibration: true` (here and on the estimate) marks a
  run that puts one config on both arms, to measure this setup's own noise; it should come out
  "no detectable difference". `config_hashes` must then name one config twice (`[h, h]`), else 400
  `invalid_calibration`; a calibration cannot reuse a parent's trials (400
  `invalid_calibration`). Without the flag, the same config twice stays a 400
  `invalid_experiment` "config_hashes lists the same hash twice" (A30), whose `fix` now also
  offers the calibration flag. A calibration is otherwise an ordinary run: the same estimate
  (both arms), budget check and plan commit rules. Its arm B trials have repeats `n` to `2n - 1`
  (arm A's are `0` to `n - 1`), which is how the arms, counts, events, export (`arm`) and
  compare tell them apart; each arm can be paused and resumed by its letter, and a config error
  pauses both (one config). `calibration` is on `GET /experiments` and the detail;
  `experiments.calibration` is migration 012, whose check keeps the flag and "one config twice"
  together.
- **Arms (D35).** `config_hashes` holds one config (a pilot) or two: arm A, then arm B. More is a
  400 `too_many_arms` (on the estimate too), with the fix "Run several A/B experiments against
  the same parent".
- **Claim order (D32).** `order_seed` (optional, 0 to 2^32 - 1) seeds the shuffle; without one a
  random seed is drawn, and either way it is stored and shown as `order_seed`. Every (task,
  repeat) is a block with one trial per arm; the blocks are shuffled, and so is the arm order
  inside each block, so the arms alternate and any early batch is a random sample. Each trial's
  place is its `order_index` (in the trial summaries); claims go in `order_index` order, and a
  re-queued attempt keeps its slot's place. The i-th random number is the first 4 bytes of
  `sha256("<seed>:<i>")` over 2^32, used in a Fisher-Yates shuffle
  (`apps/api/src/experiments/order.ts`), so the order can be rebuilt anywhere from the seed. `seq`
  stays the slot's number in plan order (repeat, task, config), which the export and the trial
  list are sorted by.
- **Run controls (D32, D37).** Each returns the experiment detail.

  | Call | From | Does |
  | --- | --- | --- |
  | `POST /experiments/:id/start` | `created`, `paused` | starts it, or resumes it (as `/resume`); marks it `done` if nothing is left to claim. Optional body `{plan_commit}` (`StartExperimentRequest`): on a `created` one it sets the analysis plan's commit first (format checked as on `POST /experiments`, 400 `invalid_plan_commit`), so an experiment left unstarted without one can be started from its run page; once it has started the commit is fixed, and a different one is a 409 `plan_commit_locked` (the same one again is fine). D75: a `created` one with a Hermes config on a real model (not `fake/*`) is a 409 `conflict_check_required` until `POST /configs/:hash/conflict-check` has a stored result for that config's current input (rendered prompt, our prompt, settings); the message names each config and the fix gives the two calls. It reads stored checks only and never calls the checker; a resume is not checked |
  | `POST /experiments/:id/discard` | `created`, no trial claimed | marks an experiment that never started `cancelled` and its queued trials `cancelled`, as a stop does; nothing is deleted. Event `discarded` (no `cancelled` event). Anything started is a 409 `experiment_started` (fix: stop it instead); a `done` or `cancelled` one a 409 `experiment_finished` |
  | `POST /experiments/:id/pause` | `running` (a `paused` one: no-op) | no new claims; trials already running finish and report; event `paused` |
  | `POST /experiments/:id/resume` | `paused` (a `running` one: no-op) | claims resume; event `resumed` |
  | `POST /experiments/:id/stop` (also `/cancel`) | `created`, `running`, `paused` | queued trials become `cancelled`; running ones finish and are kept; status `cancelled` |
  | `POST /experiments/:id/arms/:config/pause` | not `done` or `cancelled` | that arm claims nothing more; event `arm_paused` |
  | `POST /experiments/:id/arms/:config/resume` | any | that arm's queued trials can be claimed again; event `arm_resumed` |

  `:config` is the arm's config hash (or its letter, `A` or `B`). A wrong state is a 409
  (`experiment_not_started`, `experiment_finished`) and an unknown arm a 404 `unknown_arm`, each
  with a `fix`.
- An experiment's `status` is `created`, `running`, `paused`, `done` or `cancelled`. `paused` is
  the whole experiment, by hand or by D32's futility check and guards (below); `paused_at` and
  `paused_reason` are the latest. A re-queued attempt made while paused waits, queued.
- **Automatic pauses (D32).** Checked after every report and every lapsed lease (the futility
  check also after every grades report), only while the experiment is `running`. Each pauses the whole experiment with an event whose `detail` is the
  `paused_reason`; resume or stop after review. None of them looks at the difference between the
  arms: the verdict uses the full planned N, so nothing stops or decides on an apparent win.
  - **Futility**, `futility: {enabled, after, min_passed}` on `POST /experiments` (left out:
    `{enabled: true, after: 3, min_passed: 1}`, or `enabled: false` when every model the run calls,
    each arm's and the simulated client's when a task needs one, is `fake/*`, since the check
    protects spend and such a run spends nothing (A41, since 5 Nov; the same reading of the run as
    the fake-only budget rule); `{"enabled": false}` turns it off and any other object turns it
    on, whatever the models; shown resolved as `futility` in the detail). Once per arm: when the arm has `after` graded trials, it pauses
    the run if fewer than `min_passed` of them passed. **Passed is the grading outcome** (SP4,
    since 4 Nov): a trial whose current grading outcome is `pass` counts as a pass and `fail` as a
    fail; one whose grading is `incomplete`, has not finished, or has no graders is not counted at
    all. Grading runs after the trial, so the check runs on the grades report too
    (`applyFutility` in `apps/api/src/experiments/rules.ts`). Event `futility_pause`, for example
    "futility check (D32): arm B passed 0 of its first 3 graded trials, fewer than the 1 the rule
    asks for (passed means the grading outcome is pass; a trial whose grading is incomplete or not
    finished yet is not counted) ...". The first batch is a random sample because of the claim
    order. An arm whose trials are reused from the parent is not checked.
  - **Infra guard**: more than 30% infra failures (`infra_failed` or `abandoned`) among at least 5
    trials finished since the run started or was last resumed. Event `infra_guard_pause`, naming
    the failure labels. The count starts again at each resume.
  - **Spend guard**, once per experiment: spend so far plus every queued or running trial at its
    arm's mean cost so far (the estimate's per-trial cost for an arm with none finished) passes
    `budget_usd`. Event `spend_guard_pause`. After a resume it does not fire again; LiteLLM's
    experiment budget still stops spend at the cap.
- **A config error pauses only its arm (D37, amending D26).** A report labelled
  `infra:config_error` pauses that trial's arm, not the experiment: claims skip the arm's trials,
  its running trials finish, and the other arm keeps claiming. The arm's `paused_reason` names the
  trial, its config, LiteLLM's status and the provider's message; its `fix` says what to do by
  LiteLLM's status (401/403: the key in LiteLLM's environment; 404: the model's route; 400: a
  setting the model rejects needs a forked config and a new experiment, a key or account problem
  is fixed in LiteLLM), then resume the arm. If that was the last trial, the experiment is `done`
  with the arm still paused, and compare waits until the arm is resumed.
- `arms` in the experiment detail: `[{arm, config_hash, config_name, status, paused_at,
  paused_reason, fix, counts}]`, arm A first. `status` is `not_started`, `active` (trials
  queued or running), `paused`, `stopped` (some of its trials were cancelled) or `complete`
  (every slot has a final attempt: done, or an infra failure that is not re-queued).
- `GET /experiments` returns `[{id, name, axis, status, config_hashes, n, counts, spend_usd,
  estimate, created_at, example}]`, where `counts` is `{queued, running, done, infra_failed,
  abandoned, cancelled}` and done is split by label. `example` is `{name, title, loaded_at}` for
  a shipped example loaded with `POST /examples/:name/load` (sample content, read-only; see
  Shipped examples below) and null for your own experiments; the detail has it too.
- `GET /experiments/:id` adds `actual` next to `estimate` (item 8): null until a trial has
  finished, then `{finished_trials, spend_usd, cost_per_trial_usd, wall_s_per_trial,
  elapsed_minutes, projected_spend_usd}` (elapsed from the start to the finish or now; the
  projection is the spend guard's). Reused trials are the parent's spend, not this one's. An
  abandoned attempt's spend (G3) is in `spend_usd` and the projection, but the attempt is not a
  reported trial: `cost_per_trial_usd` is the whole spend over the trials that reported, and the
  spend guard projects the trials left at that mean, crashed attempts' spend included.
- `GET /experiments/:id` also adds `platform_commit` and `platform_commit_source` (`env`, `git`
  or null; above), `tasks`, `configs`, `arms`, `order_seed`, `futility`,
  `parent_experiment_id`, `baseline`, `paused_at`, `paused_reason` and `events`, newest first: `[{at, kind, trial_id, attempt, arm, config_hash,
  detail}]`. Claims, infra failures, config errors, re-queues, budget trips, abandons and file
  problems come from the trial rows; pauses and resumes (`paused`, `resumed`, `arm_paused`,
  `arm_resumed`, `futility_pause`, `infra_guard_pause`, `spend_guard_pause`), the `baseline`
  decision and a `discarded` experiment are stored as they happen.
- `GET /experiments/:id` also adds `judge`: the experiment's active judge approval, `{model,
  budget_usd, spend_usd, approved_at}`, or null when judging is not approved. `spend_usd` is the
  sum of `spend` over LiteLLM's spend-log rows for the judge's key, read on each request, and
  null when LiteLLM cannot be read. The key itself is never in it.
- **Judge approval (SP4, R8).** Real-model judging needs Rishi's sign-off with a cap, per
  experiment. Types: `JudgeApprovalRequest`, `JudgeApprovalResponse`, `JudgeRevokeResponse`,
  `JudgeView`; table `judge_approvals` (migration `010_judge.sql`, at most one active approval
  per experiment).
  - `POST /experiments/:id/judge` with `{model, budget_usd}`. `model` must be a model LiteLLM
    serves with a price (looked up as for configs, so `fake/*` counts at its made-up prices);
    `budget_usd` a number above 0 and at most 20. The API mints a LiteLLM key with `models:
    [model]`, `max_budget: budget_usd`, alias `judge-<experiment id>` and metadata
    `{experiment_id, kind: "judge"}`, stores it, and answers 201 `{experiment_id, model,
    budget_usd, approved_at}`. Any experiment status may be approved: an approval made after
    the trials finished applies to the next regrade, since the claim reads it.
  - `DELETE /experiments/:id/judge` deletes the key in LiteLLM, then sets `revoked_at`, and
    answers 200 `{experiment_id, revoked_at}`. A key LiteLLM no longer has (a 4xx on delete)
    counts as deleted; a LiteLLM 5xx or no answer is a 502 and the approval stays active, so a
    key that still works is never shown as revoked. The spend LiteLLM shows for the key at that
    moment is kept (`revoked_spend_usd`) as a floor and a fallback for `GET /spend`.
    Approving again after a revoke mints a new key.
  - Refusals, each with a `fix`:

    | `error` | When |
    | --- | --- |
    | `unknown_experiment` (404) | no such experiment (approve and revoke) |
    | `invalid_judge` (400) | not an object; `model` missing or empty; `budget_usd` not a number above 0 and at most 20 |
    | `unknown_model` (400) | LiteLLM serves no such model, or serves it without a price (its spend could not be capped or counted) |
    | `provider_key_missing` (400) | the model's provider key is known not to be set (`ANTHROPIC_KEY_SET` or `GEMINI_KEY_SET` empty, as `key_set: false` on `GET /models`), so every judge call would fail. The message and the fix name the variable (`GEMINI_API_KEY`): add it to `.env`, run `docker compose up -d`, approve again, or pick a fake model. No key is minted. When the API was not told (the flag absent), it does not refuse |
    | `judge_already_approved` (409) | the experiment has an active approval: revoke it first. Two approvals at once: one wins, the other's key is deleted and it gets this 409 |
    | `no_judge_approval` (404) | revoke with no active approval |
- `GET /experiments/:id/trials?status=&config=&task=` returns trial summaries
  (`TrialRowSummary`). Each has `grading` (`TrialGradingState`) and `passed`, so the run grid
  agrees with the trial page: `pass`, `fail` or `incomplete` is the outcome of the trial's latest
  finished grading job (as `grading.current` in `GET /trials/:id`); `waiting` is a done trial
  whose grading is queued, running or not queued yet; `no_graders` a done trial of a task with no
  graders; `grading_failed` a done trial whose last grading job gave up (3 lapsed leases) with no
  finished job before it; `null` a trial that is not done (nothing to grade). `passed` is true or
  false with a `pass` or `fail`, else null. `cause` (D64) is the trial's failure cause
  (`TrialCause`, below) when it is done and failed or ended other than `answered`, else null.
- **Failure causes (D64; rules in `docs/assumptions.md` A45, `apps/api/src/causes/`).** A
  `TrialCause` is `{cause, reason, contributing: [{cause, reason}], rules_version}`: the first rule
  that matches is `cause`, every other rule that matches is in `contributing`, in rule order.
  `cause` is one of `CAUSE_KINDS`: `ran_out_of_steps`, `judge_vs_label`, `wrong_tool`,
  `gave_up_early`, `made_up_arguments`, `tool_error`, `unsupported_figure`, `wrong_answer`,
  `other`. `reason` is one plain sentence quoting the evidence ("calculate_emi was never called;
  amortization_schedule was"), saying what is harness-specific (Hermes's summary at the step
  limit, the own loop's re-send of a cut-off reply, how each harness passes a tool error back).
  Only done trials (agent outcomes) get one; infra failures keep their infra label. The rules
  read what is already recorded (end state and stop reason, execute_tool spans, the current
  grading's grades with their reasons and evidence, the grader specs of that grading, the
  spec's limits and `required_tools`, Rishi's labels, rater `rishi` only since D73) and call no
  model; nothing is regraded.
  `rules_version` is `causes-1`. Causes are computed on each read, not stored, so a new label or
  a regrade shows at once.
- `GET /experiments/:id/compare` returns `{experiment_id, status, reason, arms, rows, stats,
  stats_note, grader_versions, prose_figures, behaviour}`.
  **No comparison until every arm is complete** (D37, D32): while `status` is `incomplete`,
  `reason` says why ("arm B is paused: ...", "the experiment was stopped before every trial ran
  (...); a verdict needs the full planned N (D32)", "the experiment is paused: ...", "arm A has 3
  trials queued or running", "the experiment has not been started") and `rows` is empty, so no
  pass counts are shown off a partial run. Once `complete`, `rows` holds per task and arm `{task,
  task_id, arm, config, config_name, passed, graded, incomplete, trials, infra_failed, abandoned}`
  and `stats` the verdict and its intervals (SP6, below). Each done trial
  counts by its latest finished grading job's outcome, as on the run grid: `passed` is the trials
  whose outcome is `pass`, `graded` those with `pass` or `fail`, and `incomplete` those whose
  grading finished with no outcome (a required grader errored, was not applicable or is the
  unapproved judge). Older grade versions and optional graders do not count.
- **Figures written without a tool (D61).** Once `complete`, `prose_figures` holds per arm
  `{arm, trials_measured, trials_unmeasured, amounts, derived_in_prose, per_trial, share}`, summed
  over the arm's done trials from each runner report's `checks.amounts` and
  `checks.derived_in_prose` (runner 0.4.0 on): the money figures the agent worked out in prose that
  the checks verified by recomputing them. A trial whose report lacks the counts (checks from
  before D61) is `trials_unmeasured`. A measure beside the verdict, never part of it or a gate;
  the comparison page shows it with each arm's behaviour. Empty while `incomplete`.
- **How each arm behaved (D64).** Once `complete`, `behaviour` is `{rules_version, arms, paired}`
  (`CompareBehaviour`); null while `incomplete`. Each of `arms` (A, then B) covers the arm's done
  trials, a reused arm A's included, and an A/A run's arms by repeat: `trials`; `tool_calls`
  (`total`, `per_trial`) and `by_tool` (`{tool, calls, per_trial, errors, trials}`, most called
  first), counted from the execute_tool spans with Hermes's `mcp__finance__` removed;
  `required_tools`, per tool a task wants (its `required_tools` and the tool of each required
  `tool_called` check), `{tool, trials, called, share}` over the trials of the tasks that want it;
  `tool_errors` (`total`, `per_trial`, `trials` with at least one); `steps` (model calls from
  LiteLLM's records, D17: `trials_measured`, `per_trial`, and `step_limit`, the trials that ended
  `step_limit`); `end_states` (`{end_state, trials}`, most first); and `causes` (`trials` with a
  cause, and `by_cause`: `{cause, primary, contributing}` per cause, in rule order). `paired` has
  `tool_calls` and `steps` per trial as `BehaviourStat` (`{metric, tasks, a, b, diff, relative,
  trials}`): B minus A per task with the same task bootstrap as `costs`, seeded
  `<experiment id>:behaviour:<metric>`, over tasks with a value in both arms, and no verdict; empty
  for a pilot of one config. None of it changes the verdict: it explains the pass rate.
- **Both arms graded alike, or no verdict (D72, since 5 Nov; `GraderVersionCheck` in
  `contract.ts`, `apps/api/src/stats/graded-alike.ts`).** Once `complete` and graded (not for a
  pilot, not while grading runs, when it is null), `grader_versions` is `{alike, blocking,
  optional, note}`. On each task, every grader's current grades over both arms' done trials must
  come from one `grader_version` and, for a judge, one `judge_model` (among the grades that called
  a model; one that called none is incomplete already). A mix inside an arm differs too, and a
  trial whose current grading has no grade from a grader the task's other trials have (a `no_graders`
  grading included) counts as a version of its own; a done trial with no finished grading is left
  out of the check. Each grader that differs is a `GraderVersionDifference`: `{task, task_id,
  grader_id, required, kind, changes, versions}`, where `required` is true when it is required in
  any of those gradings, `changes` lists what differs (`spec`; `files`, a file it reads under the
  same spec, such as a judge's rubric or a unit test's grader.py; `framework`; `judge_model`;
  `not_graded`) and `versions` is `[{grader_version, judge_model, a, b}]`, the done trials of each
  arm on that version, most first. Required ones are in `blocking`: then `stats` is null and
  `stats_note` says why, for example "The two arms were not graded alike (D72): 1 required check
  on 1 of 10 tasks has current grades from different grader versions, which would score the arms
  by different rules: advice on payoff-order (its rubric changed). Regrade the
  experiment (POST /api/experiments/e_x/regrade), which also regrades the 100 trials arm A reuses
  from e_parent so every trial is graded with the graders as they are now; the verdict comes back
  once those grades are in." (three graders by name, then "and N more"). Optional ones are in
  `optional`, named in `note`, and the verdict is still given: an optional grader never decides a
  trial's outcome, though its own pass rates in `regressions` then compare different versions.
  `alike` is true when both lists are empty. `rows` keep their pass counts either way.
- **Statistics (SP6: D10, D41, D42, D43, D44, D50; `CompareStats` in `contract.ts`).** `stats` is
  null, with `stats_note` saying why, for a pilot of one config, while any done trial's grading is
  queued or running ("Grading is still running for 4 of 4 finished trials; ..."), when the arms
  were not graded alike (D72, above), or when no task has a decided trial in both arms. Otherwise,
  from each done trial's current grading, B minus A:
  - the task is the unit: per task and arm, pass rate = `passed / graded` (incomplete trials left
    out and counted); a task with no decided trial in an arm is in `excluded_tasks` with `why`;
  - `diff`: the mean over tasks of the per-task difference, in points, with a 95% interval from a
    task bootstrap (10,000 resamples of the tasks, percentile method; D10 as revised 5 Nov:
    trials are not resampled again inside tasks); `a` and `b` give each arm's mean task rate and
    pooled counts;
  - `p_value`: the paired sign-flip permutation test on the per-task differences, two-sided,
    exact up to 30 tasks (`test.exact`, `test.flips` = 2^K), else 20,000 seeded flips;
  - `verdict` (D42, D43, D50): `better` (interval above 0 and p < 0.05), `worse` (below 0 and p <
    0.05), `equivalent` (the whole interval inside +/- `margin_points`, 10), else
    `no_detectable_difference` with `not_ruled_out_points` (null when every task gave the same
    difference, so the interval has no width); with fewer than 6 tasks in the
    aggregate it is always `no_detectable_difference`. `held_back` when the pass rate alone says
    better (`pass_rate_verdict`) but `critical` says critical failures rose. `verdict_text` says it
    in a sentence;
  - `tasks`: per task, counts, Newcombe's 95% interval (`diff`, points), Fisher's exact `p_value`,
    the Benjamini-Hochberg `q_value` and `beyond_noise` at q = 0.05 (D41);
  - `critical` (D10): each grader's `severity` is read from the grader specs of the grading that
    produced the trial's grades (the task file it graded with). Per task with a required critical
    check, the share of decided trials where one failed, compared like the pass rate. `status` is
    `no_critical_checks` ("no check is marked critical"), `no_decided_trials`, `rose` (interval
    above 0) or `did_not_rise`; `blocks_better` when it turns a better into `held_back`;
  - `regressions` (D10): every task where B dropped (`diff` below 0) or a check's own pass rate
    fell, critical first, with `graders` (id, required, severity, per-arm counts),
    `failed_trials` (arm B first, at most 10 per arm, each with the required checks it failed and
    its `cause`, D64) and `causes_grew` (D64: `{cause, a, b}` for each primary cause that was more
    common on the task's trials in B than in A, most grown first; causes are filled after the
    cached statistics, so a new label shows without a regrade);
  - `costs`: `cost_usd` (LiteLLM's recorded cost of the agent's calls; `made_up_prices` on a fake
    model), `tokens` (input plus output) and `wall_s` (the trial's run time), each the same task
    bootstrap over tasks with a value in both arms, as `diff` and `relative` (percent), no
    verdict. **`wall_s` leaves out every trial in which LiteLLM retried a model call** (its spend
    log's `attempted_retries`, as `proxy_usage.retried_calls` on the runner report or
    `evals.proxy.attempts > 1` on any chat span, the simulated client's included): its backoff
    waits would make that arm look slower.
    `left_out_retried` counts them per arm and `retries_unknown` the trials kept whose record does
    not say;
  - `aa` (D44), on an ordinary A/B: the latest finished calibration run (`status: done`) of either
    arm's config, `{experiment_id, name, config_hash, finished_at, diff, verdict}`, or null; a
    calibration with no statistics of its own (one whose arms were not graded alike, D72, included)
    is passed over. Your own
    experiment reads only your own calibrations, and a shipped example only shipped ones (since
    5 Nov, so the headline example shows the A/A shipped beside it); `calibration`, on a calibration run: `{as_expected, text}`, whether it came
    out with no difference found;
  - `judge`: SP5's agreement, null until SP5 reports it.
  `seed` is the experiment id, so the same data always gives the same numbers; results are cached
  by the trials and their current grading jobs, so a regrade recomputes them.
- `GET /experiments/:id/export?format=json|csv` streams every trial row (infra failures,
  abandoned and cancelled rows included) joined with its config, task, grades and spend. An
  abandoned row carries the spend the lease sweep read for it (G3); `spend_unknown` (a CSV column
  after `sim_cost_usd`, and in the JSON's `spend`) is true when LiteLLM could not give it, so its
  empty cost is unknown, not zero. `served_model` (a CSV column after `model`, and in the JSON
  rows; since 5 Nov) is the model id the provider said it served for the agent's calls
  (`gen_ai.response.model` on LiteLLM's chat spans, space-separated if more than one), since a
  config names its model by alias. Each
  row has `arm` (`A` or `B` by the config's place in the experiment; in a run of one config twice,
  the second arm's repeats come after the first's) and `outcome`, the trial's current grading
  exactly as the run grid (`grading` on `GET /experiments/:id/trials`) and the comparison count
  it: `pass`, `fail` or `incomplete` from the latest finished grading job (`done` or
  `no_graders`), `no_graders`, `waiting`, `grading_failed`, or empty for a trial that is not
  done. `cause` (D64) is the trial's failure cause: in the CSV its kind, `cause_reason` and
  `causes_contributing` (the contributing kinds, `;`-separated), empty for a trial with none; in the
  JSON the whole `TrialCause` or null. Since 5 Nov `grades_passed`, `grades_total` and `grades_json` (CSV) and `grades` (JSON)
  cover only that current grading's grades, so a regraded trial is not counted twice; the JSON
  adds `grading_job_id` and `grade_history`, every stored grade version. Both carry the name the
  screens show (since 5 Nov, QA round 3): `experiment_title` is the second CSV column and a
  top-level key of the JSON, beside `experiment`. It is a shipped example's title (its manifest's,
  as `example.title` on `GET /experiments`), else the experiment's own `name`; an example's stored
  `name` stays the working name it was run under. Older versions also stay
  in the database and in `GET /experiments/:id/bundle`. Each grade is `{grader_id,
  grader_version, kind, required, verdict, score, evidence, judge_model, run_index, job_id}`.
- `GET /experiments/:id/bundle` (SP7) returns every row needed to recreate the experiment in
  another database, read in one read-only snapshot: `{format: "agent-evals-bundle",
  format_version: 1, schema_version, exported_at, experiment_id, tables}` (`ExperimentBundle`).
  `tables` holds, in insert order, `prompts`, `toolsets`, `tasks`, `configs` (the experiment's
  and the configs they were forked from), `experiments`, `experiment_arms`, `experiment_events`,
  `trials`, `spans`, `grading_jobs` and `grades` (every version). Each row is the table's own
  columns as Postgres's `to_jsonb` writes them (so `tasks.client_state` is hex, `\x...`), except:
  `spans` rows are `{trial_id, raw}` (the other columns are read from `raw` again on load),
  `experiment_events` rows have no `id`, and a trial's `agent_key_token` and `sim_key_token` and
  the experiment's `litellm_team_id` are never included. `schema_version` is the latest migration
  applied. The trials' files are not inline: fetch each with `GET /trials/:id/files/<path>`, as
  listed in the trial's `files`. 404 `unknown_experiment`. `scripts/export_example.py` reads this.

## Trials

- `GET /trials/:id` returns `{id, experiment_id, probe, task, config, repeat_index, attempt, status,
  label, end_state, result, runner_report, usage, timing, files: [{path, bytes, sha256}],
  grades, grading, problems, cause}`. A probe trial (D33) has `probe: true` and `experiment_id: null`. `grades` are
  those of the trial's latest finished grading job (see Grading), each `{id, grader_id,
  grader_version, kind, type, required, verdict, score, reason, evidence, judge_model, run_index,
  created_at}`; `cause` is the failure cause its row has (D64), null for a probe; `grading` is `{current, pending}`: the job those grades came from (`job_id,
  status, reason, grader_source, source_note, task_sha256, framework_version, passed, outcome,
  error, queued_at, graded_at`), and a newer job still queued, claimed or failed. Both are null
  before the first grading.
  `runner_report.proxy_usage` is stored as the runner wrote it; since D16 it carries `attempts`
  (LiteLLM's tries at the provider) and `retried_calls` beside `model_calls` (the harness's
  requests). The API does not index those two yet.
- `GET /trials/:id/spans` returns contract v2 spans in time order.
- `GET /trials/:id/files/*path` streams one stored file (path traversal refused).
- The existing folder-based `/trials` endpoints (`FileTrialStore`) stay for runs recorded
  outside an experiment (gate and smoke runs), listed with `experiment_id: null`.

## Worker protocol (D2)

A worker serves one harness. Its loop: claim, run, heartbeat while running, upload the trial's
files, report. Workers talk only to the API over HTTP and mount nothing from the host, so a
trial cannot read or change another trial's stored files (D3).

1. `POST /worker/claim` with `{worker_id, harness}`. Returns 204 when nothing is queued for
   that harness, or 200 with
   `{trial_id, attempt, experiment_id, spec, state_files: {"client.json": "<base64>"},
   keys: {model, sim}, budgets: {trial_usd, sim_usd}, lease_s: 60, folder, sim_cache}`. `spec` is a
   complete contract v2 spec whose `model.base_url` is LiteLLM as seen from the worker.
   `folder` is where the API will store the attempt's files, relative to `runs/`; the worker
   does not use it. The claim is one `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP
   LOCKED)`, so two workers never get the same trial.

   A probe trial (D33, see Pre-run checks) is claimed the same way, ahead of queued experiment
   trials for that harness, with `experiment_id: null` (also in `spec.trial`, with `task_split:
   null`, as contract v2 allows outside an experiment), `spec.model.name: "fake/finance-emi"`,
   `budgets: {trial_usd: 0.5, sim_usd: 0}`, `folder: "probes/<trial_id>/attempt-1"` and
   `sim_cache: null`. Workers need no change for it.

   `sim_cache` (D22) is `{<cache key>: <reply>}`: every non-empty simulator reply stored so far
   for the same task (sha256), simulator model, temperature (a `null` one, not sent, is its own scope),
   token cap and simulator prompt, from any earlier trial, experiment or harness. Keys are
   `evals_adapter.sim.cache_key`, which hashes those same values, the client summary when there
   is one, and the visible transcript, so one key is one conversation state. It is
   `{}` before any reply is stored, and `null` for a task without a simulated client. The
   worker's runner writes it to `/trial/sim_cache.json`; a turn whose state is in it gets the
   stored reply and makes no simulator call. The agent's own calls are never cached.
2. `POST /worker/trials/:id/heartbeat` with `{worker_id, attempt}` every 10 s. 200 keeps the
   lease; 409 `claim_lost` means the API gave up on it (stop the trial, report nothing).
3. `GET /worker/trials/:id/calls?role=agent|sim` returns LiteLLM's spend-log rows for that
   trial's key, as LiteLLM returns them. The worker's runner polls this the way it polls
   LiteLLM today (`ProxyClient.call_records`) and merges the rows into its spans.
4. `PUT /worker/trials/:id/files/*path?worker_id=<id>&attempt=<n>`, once for each regular file
   of the trial's `out/` folder, after the run and before the report. The body is the file's
   raw bytes, with `Content-Type: application/octet-stream`, a `Content-Length`, and
   `X-Content-Sha256` (`sha256:<hex>` or bare hex). `path` is relative to `out/`, each segment
   percent-encoded. The API streams the body to a temporary file next to the attempt folder,
   hashing it on the way, and links it into `runs/<experiment_id>/<trial_id>/attempt-<n>/<path>`
   only when the hash matches, so a stored file is always whole. Answers:
   - 201 `{path, bytes, sha256, duplicate: false}`: stored.
   - 200 the same with `duplicate: true`: those exact bytes were already stored (a retried
     upload). A stored file is never overwritten.
   - 400 `invalid_path` (absolute, `..`, empty or dot segments, backslash or NUL),
     `invalid_upload` (no or bad hash header, no `worker_id` or `attempt`), `hash_mismatch`
     (the bytes do not match the header; nothing is stored).
   - 409 `file_conflict` (different bytes already stored at that path), `claim_lost` (the
     worker does not hold the attempt, for example after its lease lapsed: stop, report
     nothing), `attempt_mismatch`, `already_reported` (a new path after the report; the same
     bytes again are still a 200).
   - 411 without a `Content-Length`; 413 `file_too_large` for over 64 MB, decided from the
     `Content-Length` before the body is read; 415 for another content type.

   The worker sends regular files only: symlinks and special files are skipped, never followed.
   A file over 64 MB is not sent but stays in the report's `files`, so the API flags it as not
   uploaded. Network errors, 429 and 5xx are retried with back-off, under one deadline with
   the report. Files an attempt uploaded before its lease lapsed stay in its folder; its
   `abandoned` row says it never reported.
5. `POST /worker/trials/:id/report` with `{worker_id, attempt, runner_report, result, spans,
   files: [{path, bytes, sha256}]}`. `files` names every file of `out/`, each already uploaded
   in step 4; `sha256` may be `sha256:<hex>` or bare hex and is stored as `sha256:<hex>`. The
   API re-hashes what it stored and flags any file that was not uploaded or differs (the
   report is accepted, with the trial's `problems` saying so). For a simulated-client trial
   the API then reads the uploaded `sim_replies.jsonl` (`{key, reply, model, usage}` per line)
   and adds its replies to the cache, scoped by the trial's spec; the first reply stored for a
   key is kept, and a line that is not a `sha256:<hex>` key with a string reply, or is from
   another model, is left out and noted in `problems`. A line with an `error` field (an empty
   simulator reply, a simulator failure under D26) stays in the stored file but is never
   cached, so the re-queued attempt asks the simulator again; an unmarked reply that is empty
   or only spaces (from an adapter before that rule) is left out and noted. The end marker
   alone, unmarked, is cached. The response's `sim_replies_stored`
   counts the replies added. Reporting the same attempt twice
   is a no-op 200. The API revokes the trial's keys, stores the report, and sets the status:
   `done` for an `agent` label; for an `infra:*` label, `infra_failed` and, if this was
   attempt 1, a new `queued` attempt 2 (D16: re-queued once, never twice), except for the two
   labels that are never re-queued (D26): `infra:config_error`, which also pauses its arm
   (D37), and `infra:budget_net`. `infra:provider_error` (429, 5xx or LiteLLM's 408 timeout,
   still failing after LiteLLM's own retries, D16), `infra:sim_error` (the simulated
   client's call failed or its reply had no text, D26), `infra:adapter_crash` and
   `infra:timeout_kill` are re-queued once. Each infra attempt is an `infra_failure` event
   naming its label, and each re-queued attempt a `requeue` event. After the report, D32's
   futility check and guards run for the experiment.
   A probe trial is never re-queued and pauses nothing (no arm, no guard)
   (nor is a lapsed one); `POST /configs/:hash/rendered-prompt` probes again. Claims hand out
   queued probes first, then each running experiment's trials in `order_index` order, skipping
   paused arms.
6. A lease with no heartbeat for 60 s lapses: the API marks the attempt `abandoned`, revokes
   its keys, and queues the next attempt under the same cap (also while the experiment is
   paused; the attempt waits for the resume). **Before revoking (since 5 Nov, G3)** it reads
   LiteLLM's spend log for the attempt's agent key, and its simulator key when it had one, and
   stores them on the abandoned row as a report would: `cost_usd` and `input_tokens`,
   `output_tokens`, `model_calls` from the agent key's rows, `sim_cost_usd` from the simulator
   key's (null without one). So the attempt's spend counts in `GET /spend`, the experiment's
   `spend_usd` and `actual.spend_usd`, the spend guard and the export. When LiteLLM cannot be
   read, the row gets `spend_unknown: true` and its costs stay null, unknown and not zero; while
   its keys are still live (LiteLLM down, so their revoke failed too) the next sweep reads again
   and clears the mark. The log of a key already revoked is never read for this (assumption A19
   is unchecked), so an attempt whose log could not be read but whose keys were revoked keeps the
   mark. Attempts abandoned before migration 015 are marked unknown.

## Grading (SP4, R14)

Grading is its own step after the trial, so a grader fix re-grades old trials without re-running
them. The grader worker (`evals-grader`, `graders/`, compose service `grader`) uses the worker
token and talks to the API only over HTTP (D2). The grader format is a draft for Rishi:
`docs/proposals/grader-format.md`. Types: `GraderClaimResponse`, `GradesReportResponse`,
`RegradeResponse`, `Grade`, `TrialGrading`, `JudgeAccess` in `apps/api/src/contract.ts`. Tables:
`grading_jobs` and `grades` (migration `007_grading.sql`), and `judge_approvals` for the judge's
key (`010_judge.sql`; approving and revoking are under Experiments).

- **A grading job** is one grading of one trial with a frozen grader set: the task's grader specs,
  each with the API's `spec_sha256` (canonical JSON of `{spec, files}`, where `files` holds the
  sha256 of each file the grader reads, or null when it is missing), and the grader files
  themselves. A unit_test reads its grader file next to `task.json`, keyed by its name
  (`grader.py`). A judge reads its rubric, keyed by its repo path: a string `rubric` is the path,
  `{id, version}` is `configs/rubrics/<id>.<version>.md`, and the path must match
  `^configs/rubrics/[A-Za-z0-9._-]+\.md$`, otherwise the judge has no file (no entry in `files`,
  as for an invalid unit_test file name). The API reads it from its configs folder
  (`CONFIGS_DIR`, the repo's `configs/` by default), only a regular file directly in
  `rubrics/` (no `..`, no symlink), at most 256 KB, as raw bytes (a review header included).
  So editing a rubric, like editing a grader.py, gives the judge a new `spec_sha256` and new
  grade versions. A judge spec's hash input is, for example, `{"files":
  {"configs/rubrics/open-coding.v0.md": "sha256:<hex of the file>"}, "spec": {...}}`. The rubric
  is not part of the task, so it is read as it is now whichever task the graders come from. Jobs are queued, at claim time, for every `done` trial (never a probe, never an infra
  failure) that has none; a task with no graders gets a `no_graders` job with nothing to claim.
- **Which graders.** The current `tasks/<id>/task.json` when it differs from the trial's task only
  in `graders`, `version` or `summary` (`grader_source: catalogue`), so a grader fix applies.
  Otherwise, when the task itself changed (its messages, simulated client or client file) or is
  gone, the trial's own task (`grader_source: trial_task`, with `source_note` saying why); its
  unit_test files are then unknown (`null`), so those grades are `error`.
- **A grade's version** is `sha256(canonical {"framework": <framework version>, "spec":
  <spec_sha256>})`, the same in Python (`evals_graders.canonical`) and TypeScript
  (`apps/api/src/grading/grading-core.ts`), checked by shared vectors in
  `graders/tests/hash_vectors.json`.
- **A judge grade's model** (`judge_model` on grades, in `GET /trials/:id` and the export; since 5
  Nov, D72) is the model it called: the `model` of its `judge_call` evidence item, which the Python
  judge writes whenever it makes a call. The API stores it when the grades are reported; for a
  grade stored before then (the column was never written) it is read from that evidence item. Null
  when the judge called no model (not approved, or it stopped before the call) and for every other
  kind of grade. The model is not part of the grader version, so the comparison checks it beside the
  version (D72, Experiments).

1. `POST /grader/claim` with `{worker_id}`. 204 when nothing needs grading, or 200 with
   `{job_id, attempt, trial_id, lease_s: 120, task: {id, sha256, grader_source, note, summary},
   graders: [{spec, spec_sha256}], grader_files: {<name or repo path>: {sha256, base64} | null},
   trial: {files, end_state, label}, judge: {base_url, api_key, model} | null}`. `attempt`
   counts the job's claims. `task.summary` is the trial's task summary from the tasks table, the
   one the blind labelling screen shows, or null. `grader_files` keys are a unit_test's file
   name or a judge's rubric path (`configs/rubrics/open-coding.v0.md`), so a key may hold `/`.
   `judge` is null unless the job's experiment has an active judge approval and the job has a
   judge grader; then it is that
   approval's LiteLLM key and model. The job's experiment is the one whose regrade queued it
   (`grading_jobs.regrade_experiment_id`, migration `016_regrade_experiment.sql`, since 5 Nov, D72),
   else (a first grading) the trial's own; so a trial arm A reuses from a parent (D34) is judged
   under the regrading experiment's approval and budget, never the parent's. The key is that
   approval's LiteLLM key and model, and `base_url` is the same OpenAI-compatible LiteLLM URL a
   trial spec's `model.base_url` gives workers (`LITELLM_URL` + `/v1`, `http://litellm:4000/v1`
   in compose). It is read at each claim, so an approval made after the trials finished
   applies to the next regrade, and a claim made after a revoke (a lapsed job claimed again
   included) carries none. Without it the judge grader answers `not_implemented` ("judging not
   approved for this experiment"). The claim is `FOR UPDATE SKIP LOCKED`
   over queued jobs and claimed jobs whose lease has lapsed, so a crashed grader's job is claimed
   again; after 3 lapsed claims the job is `failed` instead.
2. The worker downloads `result.json`, `trace.jsonl`, `runner-report.json` and `checks.json` (those
   in `trial.files`) with `GET /trials/:id/files/<path>` and checks each against the manifest's
   sha256. A file that differs is reported as `error` grades; a network error or 5xx leaves the
   job unreported, to lapse and be claimed again.
3. `POST /grader/trials/:id/grades` with `{worker_id, job_id, attempt, framework_version, grades,
   problems}`. `grades` has one entry per grader of the job, in order: `{grader_id, type, required,
   verdict, score, reason, evidence, grader_version}`. Answers:
   - 200 `{job_id, trial_id, status: "done", duplicate: false, passed, outcome, grades_stored,
     grades_reused}`. The API computes `passed` and `outcome` itself: `pass` when every required
     grader passed, `fail` when one failed, `incomplete` (passed null) otherwise.
   - 200 with `duplicate: true`: the same job and claim reported again; nothing changes.
   - 400 `grades_mismatch` (a grader missing, extra or out of order), `grader_version_mismatch`
     (the version is not the one the job's spec and the reported framework version give),
     `invalid_grade`, `invalid_report`.
   - 404 `unknown_job`; 409 `claim_lost` (the lease lapsed and another claim holds the job, or it
     is no longer claimed): drop it.
   Grades are never overwritten. A grade is `(trial, grader_id, grader_version, run_index)`: the
   same answer from the same version reuses its row; a different one (a flaky unit test, a judge
   re-run) is the next `run_index`. The job keeps the ids of its grades.
- `POST /experiments/:id/regrade` with `{}` or `{trial_ids: [...]}` (202) queues a `regrade` job for
  every `done` trial of the experiment (or those named), with the graders as above, and supersedes
  any job still queued for them. **Since 5 Nov (D72) it also covers the trials arm A reuses from a
  parent (D34)**, so one regrade can bring both arms onto the same grader versions; `trial_ids` may
  name them too, and a trial of neither is ignored. Each job records this experiment, whose judge
  approval its claim carries (above). A reused trial stays the parent's: its new grades are new
  rows (never an overwrite) and become its current grades wherever it is compared, so the parent's
  own comparison then reads them too, and gives no verdict if its arm B is left on the old version
  (D72, Experiments) until the parent is regraded. A shipped example's trials are never regraded.
  It returns `{experiment_id, trials, reused_trials, queued, no_graders, superseded,
  from_trial_task}`, where `reused_trials` counts the reused ones among `trials`. 404
  `unknown_experiment`. Nothing is re-run; old grades stay.
- Views: `current_grading` (each trial's latest `done` job, by queue order) and `current_grades`
  (its grades). `GET /experiments/:id/compare` counts each trial's latest finished job's outcome;
  the export still lists every stored grade row of a trial, all versions (`docs/known-limits.md`).

## Shipped examples (SP7)

A finished experiment can ship with the repo as sample content, so a reviewer who runs `docker
compose up` can open a solved example (comparison, trials, traces, grades) without running or
spending anything. Types: `ExampleView`, `ExampleCounts`, `LoadExampleResponse`, `ExampleRef`,
`ExperimentBundle`. Column: `experiments.example_name`, `example_title`, `example_loaded_at`
(migration `011_examples.sql`, with a check that an example is `done` or `cancelled`).

**Export** (only GET requests to the API): `python3 scripts/export_example.py <experiment_id>
--name <slug> --title "<one line>" [--description "..."] [--api http://127.0.0.1:3001/api]`
writes `examples/<slug>/`:

| File | Holds |
| --- | --- |
| `manifest.json` | `format: "agent-evals-example"`, `format_version: 1`, `name`, `title`, `description`, `sample: true`, `experiment_id`, `experiment_name`, `created_at`, `finished_at`, `exported_at`, `platform_commit` (the experiment's), `exported_from_commit` (the checkout that exported it), `source` (`bundle`, or `assembled` for an API without the bundle route; then `approximations` lists what could not be recovered exactly), `summary`, `counts` (`configs, tasks, trials, spans, grades, grading_jobs, events, files, file_bytes`), `missing_files`, `scrubbed`, `secret_check`, and `parts` (each part's `bytes` and `sha256`) |
| `rows.json.gz` | `{format: "agent-evals-bundle", format_version, schema_version, experiment_id, tables}`, as from `GET /experiments/:id/bundle` |
| `files.jsonl.gz` | one line per stored trial file: `{trial_id, path, bytes, sha256, encoding: "utf8" \| "base64", content}` |

It refuses an experiment that is not `done` or `cancelled`, has trials queued or running, or has
an arm that reuses its parent's trials (a parent link alone is cleared and noted). Every file is
checked against its trial's listed sha256. **Secrets:** wherever they appear in rows or files,
fields named `authorization`, `api_key`, `user_api_key`, `token`, `key_token`, `agent_key_token`,
`sim_key_token`, `master_key`, `worker_token`, `password` and the like are emptied, and any
`sk-...` key, `Bearer` token, compose's default secrets and the value of every `*KEY`, `*TOKEN`,
`*PASSWORD` or `*SECRET` variable in the environment or the repo's `.env` are replaced with
`[scrubbed]`. A file that had to change gets its new size and sha256 in its trial's listings.
Then a separate check reads everything about to be written and fails the export, writing
nothing, if any `sk-[A-Za-z0-9_-]{8,}`, Bearer token, known secret value or non-empty secret
field is left (a key inside a binary file cannot be scrubbed, so it fails the export).

**Routes:**

- `GET /examples` returns `[{name, title, description, experiment_id, loaded, created_at,
  counts: {configs, tasks, trials, spans, grades, files}}]`, one per `examples/<name>/manifest.json`
  the API can read (`EXAMPLES_DIR`, the repo's `examples/` by default; compose mounts it
  read-only at `/repo/examples`). `loaded` is true once this database holds the example. A folder
  whose manifest cannot be read is left out and logged.
- `POST /examples/:name/load` imports the example and answers 200 `{name, experiment_id,
  created}`; `created: false` means it was already loaded and nothing changed (a second load is a
  no-op). The load only inserts, in one transaction: the rows, with new ids for grades and stored
  events (a grading job's `grade_ids` follow), and each trial file under `runs/<its folder>/`,
  never replacing a file. Content-addressed rows already here (prompts, toolsets, tasks, configs)
  are kept and shared when their content is the same. Refusals, each with a `fix`:

  | `error` | When |
  | --- | --- |
  | `invalid_example_name` (400) | the name is not lower-case letters, digits and hyphens |
  | `unknown_example` (404) | no `examples/<name>/manifest.json` |
  | `example_invalid` (422) | the manifest or a part does not check out: wrong format, a part's sha256 differs, a file's bytes differ from its line or its trial's listing, rows that refer outside the example, an unfinished trial or grading job, counts that differ from the manifest, or columns this database does not have |
  | `example_conflict` (409) | the experiment id is already here as an experiment of its own (the machine it was exported from) or as another example; a trial or grading job id is already here; a shared row is here with other content; or a different file is already where a trial file goes. Nothing is changed |

- **An example is read-only and apart from your own work.** These answer 409 `example_read_only`
  (with a `fix`) for a loaded example: `start`, `pause`, `resume`, `stop`, `cancel`, `discard`, both arm
  routes, `regrade` and `POST /experiments/:id/judge`, and `POST /experiments` with
  `reuse_baseline` and the example as parent. Nothing claims its trials or grading jobs, and no
  grading job is queued for its trials. Its trials are left out of `GET /spend`'s `trials_usd`,
  the estimate's history and the labelling queue. Every read works on it as on any experiment
  (detail, trials, compare, export, trial view, spans, files).

## UI-only endpoints

- `GET /health` returns `{status: "ok", db: "up"|"down"|"not_configured", files: "writable"|"not_writable", files_problem?}`:
  200 when the database is up or not configured and the API can write `runs/`, `labels/` and
  `configs/prompts/`; 503 with the same body when the database is down or one of those folders is
  not writable (since 5 Nov), with `files_problem` naming each such folder, where the API sees it
  and how to fix it, in plain words. The container's health check, and so `docker compose up --wait`,
  fails on the 503; `scripts/smoke.py` checks `files` too.
- `GET /labels/queue?set=tuning|heldout|final` returns blind items `{item_id, task_summary,
  transcript, tool_calls, criteria, second_look}` with no harness, model, arm, timing, cost or
  grade. `experiment=<id>` limits it to one experiment's trials, and `items=<trial id>,...` (up to
  500, since 5 Nov, D71) to a chosen list, such as the trials a judge panel disagreed on; a listed
  trial the set would not offer is left out, and a malformed list is a 400 `invalid_items`. The
  UI takes the same as `#/labels?set=heldout&items=...`. Only trials whose agent ran on a real model are items: a `fake/*` model plays a script,
  so its output is nothing to label (since 5 Nov). Probe trials and shipped examples are left out
  too. **The sets follow the task split (D52):** `tuning` offers trials of discovery tasks only;
  `heldout` and `final` offer trials of held-out tasks only, so no task is both tuned on and scored
  on; `POST /labels` refuses a label in the wrong set with 400 `wrong_split`. **Second look (D46):** fresh criteria come first; a criterion labelled only "unsure" in the
  set comes back once, after every fresh item, as an item with `second_look: true` holding just
  those criteria. An item with fresh criteria shows those first and its second look on a later
  load, so no item is in the queue twice. **One queue per rater (D73, since 5 Nov):**
  `rater=<id>` makes "labelled", "unsure" and the second look that rater's own: a criterion
  another rater answered is still offered to this one until they answer it, and an item never
  says whether anyone else labelled it. The one rule that crosses raters is D52's: a trial
  labelled in one set, by anyone, is offered in no other set. A malformed `rater` (including an
  empty one) is a 400 `invalid_rater`. Without `rater`, any rater's label counts, as before D73;
  the experiments list and the Judge, trial and comparison pages ask that way. The Label page
  asks who is labelling before it loads anything, remembers the id in that browser, and sends it
  with every queue request and every label.
- `POST /labels` with `{item_id, set, rater, criterion, value: "yes"|"no"|"unsure", note, second_look?}`
  appends one line to `labels/<set>.jsonl` with the rater and the date (and `"second_look": true`
  on a second look). Labels are human judgments, Rishi's and the raters he names (D73), each
  entered by that person; nothing else writes them. `rater` is required: 1 to 40 lower-case
  letters, digits, dashes or underscores (`RATER_ID` in the contract), else 400 `invalid_rater`
  with a `fix`. A second look is refused (400 `not_a_second_look`) unless this rater labelled the
  criterion "unsure" in that set and has no firm or second-look answer to it yet; another rater's
  "unsure" does not count. Migration `013_label_second_look.sql` adds the second-look column;
  `017_label_rater.sql` adds `rater`, with no default, and gives the rows already stored `rishi`.
  A line without a `rater` field was written before D73 and is imported as `rishi`'s; a line whose
  `rater` is not a rater id is skipped, with a warning in the API's log.
  The agreement (`evals-agreement`) takes a second-look answer in place of the first "unsure" and
  does not count it as a relabel; an "unsure" given again stays "unsure" and is left out.
- `GET /judge/agreement?set=heldout` is SP5 and returns `null` until then.
