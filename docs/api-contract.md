# Control-plane API contract (SP2, SP3, SP7)

Status: 4 Nov 2026. Built on R14 (data model) and D2 (workers only claim and report over HTTP).
Three streams build against this file in parallel: the NestJS API, the Python worker, and the
Vue UI. Change it only by editing this file in the same commit as the code.

**As built (4 Nov):** every path below is served under `/api` (a worker calls `POST /api/worker/claim`). Each attempt is its own trial row with its own id, so a re-queued attempt gets a new `trial_id`; its folder is `runs/<experiment_id>/<trial_id>/attempt-<n>/`, which only the API writes, from the files the worker uploads (workers mount no `runs/`). A config's model and price are looked up with LiteLLM's `/model_group/info`, because `/model/info` expands the `fake/*` wildcard into about 220 names and never lists `fake/*` itself; `POST /configs` returns 400 `unknown_model` for a model LiteLLM does not serve. Experiment trials' spans come back in the raw OpenTelemetry shape. A report whose file hashes do not match is accepted and flagged, not refused. Shared request and response types: `apps/api/src/contract.ts`.

All bodies are JSON. Times are RFC 3339 UTC. Money is USD as a number. Hashes are
`sha256:<hex>`; every hash the API takes in, a worker's report included, may also be bare hex
(any case), and the API stores and returns it as `sha256:<hex>`. Errors are `{"error": "<code>", "message": "<plain words>"}` with a 4xx/5xx
status. The trial spec, result, span and runner-report shapes are contract v2
(`contract/v2/*.schema.json`); this API carries them unchanged.

## Who holds which secret

- **The API alone holds `LITELLM_MASTER_KEY`.** It mints each trial's LiteLLM keys at claim
  time (agent key, plus a simulator key when the task has a client simulator), each limited
  to that trial's model and given a budget, and revokes them when the trial is reported or
  its claim lapses. Workers never see the master key, so nothing an agent runs can read it
  (R10.3 tightened; D2). For a call the platform makes itself (the conflict check, D38) it
  mints a key for that one call, limited to the checker model with a $0.10 budget, makes the
  call with that key (never the master key), and revokes it straight after.
- Workers hold only a worker token (`EVALS_WORKER_TOKEN`), sent as `Authorization: Bearer`.
  Provider keys live only in LiteLLM.

## Catalogue (read by the UI, files in git are the source)

| Method and path | Returns |
| --- | --- |
| `GET /harnesses` | `[{name, package, ref, python, capabilities}]`, one per `workers/*/src/*/capabilities.json` (read-only mount). |
| `GET /prompts` | `[{id, version, sha256, path, text}]` from `configs/prompts/<id>.<version>.md` (the leading `<!-- -->` review header stripped, as `prompt_text` does). |
| `GET /toolsets` | `[{id, version, sha256, servers: [{name, allowed_tools}]}]`. One built-in toolset `finance/all` until more exist. |
| `GET /tasks` | `[{sha256, id, version, split, kind, summary, graders}]` from `tasks/<id>/task.json`. |
| `GET /models` | `[{name, provider, input_per_mtok, output_per_mtok}]` from LiteLLM's `/model/info`, real models only. |

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

`client_sim` is contract v2's object without `model` (the experiment supplies the simulator
model) and without `client_summary` (the API builds it). `client_state` names a file next to
`task.json` that the runner places in the trial's state folder for the finance MCP server. For a
simulated-client task the API also summarises that file (profile and debts) into the spec's
`client_sim.client_summary`, so the simulator never contradicts what the tools return (D27).

## Configs

- `POST /configs` with `{name, harness, model, prompt_sha256, toolset_sha256, settings, harness_options}`.
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

  It then computes
  `hash = sha256(canonical JSON of harness ref, adapter version, capabilities sha256, model,
  prompt sha256, toolset sha256, settings, harness_options)`. Posting the same content twice
  returns the same config (200, not a duplicate).
- `GET /configs`, `GET /configs/:hash` return `{hash, name, harness, harness_ref, model,
  prompt, toolset, settings, settings_sources, harness_options, created_at}`.
- `GET /configs/:a/diff/:b` returns `[{path, a, b}]`: every field that differs.

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
  - **Call.** `claude-sonnet-5-5` through LiteLLM's `/v1/chat/completions`, with a key the API
    mints for this call (model-limited, budget $0.10) and revokes after. `max_tokens: 2000`;
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
    characters ÷ 2 as tokens at the input price plus 2,000 output tokens at the output price
    (about $0.03 today), at LiteLLM's prices for the model. If settled spend plus open
    reservations plus this one would pass the allowance (`EVALS_CONFLICT_CHECK_ALLOWANCE_USD`,
    default 2), the answer is 402 `allowance_exhausted`, and nothing is minted, called or
    recorded. A cached result is still returned, since it costs nothing.
  - **Spend.** Each call is one `system_spend` row (kind `conflict_check`): written `pending`
    with the reservation before the call, then settled with the cost and tokens from LiteLLM's
    spend log for the key (waiting up to 10 s for the row), else from the
    `x-litellm-response-cost` header (`cost_source` says which). A cost never reported stays
    null and its reservation keeps counting against the allowance.
- `GET /configs/:hash/conflict-check` returns the stored result for the config as it is now,
  without a call; 404 `no_conflict_check` before any.
- Body: `{config_hash, rendered_sha256, input_sha256, checker: {id, version, sha256}, model,
  conflicts, notes, cost_usd, cached, skipped, spend_id, checked_at, allowance}`. `cost_usd` is
  what the check cost when it ran (also on a cached answer; `cached: true` means this request
  spent nothing). `allowance` is `{kind, limit_usd, used_usd, remaining_usd, calls,
  half_reached}`; `used_usd` counts settled costs and open reservations.

## Spend

- `GET /spend` returns `{trials_usd, system_usd, total_usd, system_by_kind: {<kind>: {usd,
  calls}}, allowances: [{kind, limit_usd, used_usd, remaining_usd, calls, half_reached}]}`.
  `trials_usd` is every experiment trial's agent and simulator cost (fake-model experiment
  trials included, at the made-up fake prices, as in each experiment's `spend_usd`); probe trials
  are left out. `system_usd` is the platform's own calls with a known cost, shown as its own line
  (D38).
- `GET /spend/system?kind=conflict_check` returns one row per platform-made call, newest first:
  `{id, kind, model, status: pending|done|failed, reserved_usd, cost_usd, cost_source, input_tokens,
  output_tokens, ref, error, created_at, settled_at}`. `ref` names what it was for
  (`config:<hash>`). `scripts/log_system_spend.py` appends the settled rows to `docs/cost.md`.

## Experiments

- `POST /experiments/estimate` with `{config_hashes, task_sha256s, n, sim_model}` returns
  `{trials, cost_usd: {expected, low, high}, minutes, basis}`. `basis` says where per-trial
  tokens came from: the mean of earlier finished trials of the same config and task when
  there are any, otherwise the assumptions in `docs/cost.md` (64k input, 2.4k output per
  trial). Prices come from LiteLLM. No power estimate yet; SP6 adds `min_detectable_effect`.
- `POST /experiments` with `{name, axis, config_hashes, task_sha256s, n, sim_model,
  budget_usd, plan_commit, sim_prompt_sha256}` creates the experiment and all its trial rows
  (`queued`), records the platform commit (`EVALS_PLATFORM_COMMIT`), and sets a LiteLLM budget
  for the whole experiment. It returns the experiment. Nothing runs until it is started. The
  simulator prompt defaults to the highest version of `client-sim` (v2 since D27). The simulator
  runs at D22's temperature 0, except on a model that refuses temperature (Haiku 5.5), where its
  temperature is `null` and not sent (D27); the token cap is 2048, because Haiku 5.5's reasoning
  counts towards it (at 300 on 4 Nov it took the whole cap and the reply was empty). An
  experiment keeps the cap it was created with. `sim` in the experiment shows all three.
- `POST /experiments/:id/start` starts a `created` experiment or resumes a `paused` one (and
  marks it `done` if nothing is left to claim); `POST /experiments/:id/cancel` (queued trials
  become `cancelled`; running ones finish), from `created`, `running` or `paused`.
- An experiment's `status` is `created`, `running`, `paused`, `done` or `cancelled`. **`paused`
  (D26):** a report labelled `infra:config_error` moves a running experiment to `paused`, with
  `paused_at` and a `paused_reason` naming the trial, its config, LiteLLM's status and the
  provider's message. Nothing is claimed while paused; trials already running finish and report
  (a re-queued attempt waits, queued, for the resume). Fix the setup (a key, the model, a refused
  setting), then start it again, or cancel it.
- `GET /experiments` returns `[{id, name, axis, status, config_hashes, n, counts, spend_usd,
  estimate, created_at}]`, where `counts` is `{queued, running, done, infra_failed,
  abandoned, cancelled}` and done is split by label.
- `GET /experiments/:id` adds `tasks`, `configs`, `paused_at`, `paused_reason`, `events`
  (claims, infra failures, config errors, re-queues, budget trips, the latest pause and resume,
  newest first).
- `GET /experiments/:id/trials?status=&config=&task=` returns trial summaries.
- `GET /experiments/:id/compare` returns per task and arm `{task, config, passed, graded,
  trials}` and, once SP6 exists, the intervals and verdict. Until then `stats` is `null`.
- `GET /experiments/:id/export?format=json|csv` streams trials joined with configs, tasks,
  grades and spend.

## Trials

- `GET /trials/:id` returns `{id, experiment_id, probe, task, config, repeat_index, attempt, status,
  label, end_state, result, runner_report, usage, timing, files: [{path, bytes, sha256}],
  grades: []}`. A probe trial (D33) has `probe: true` and `experiment_id: null`.
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
   labels that are never re-queued (D26): `infra:config_error`, which also pauses the
   experiment, and `infra:budget_net`. `infra:provider_error`, `infra:sim_error` (the simulated
   client's call failed or its reply had no text, D26), `infra:adapter_crash` and
   `infra:timeout_kill` are re-queued once. Each infra attempt is an `infra_failure` event
   naming its label, and each re-queued attempt a `requeue` event.
   A probe trial is never re-queued and pauses nothing
   (nor is a lapsed one); `POST /configs/:hash/rendered-prompt` probes again.
6. A lease with no heartbeat for 60 s lapses: the API marks the attempt `abandoned`, revokes
   its keys, and queues the next attempt under the same cap (also while the experiment is
   paused; the attempt waits for the resume).

## UI-only endpoints

- `GET /labels/queue?set=tuning|heldout|final` returns blind items `{item_id, task_summary,
  transcript, tool_calls, criteria}` with no harness, model, arm, timing, cost or grade.
- `POST /labels` with `{item_id, set, criterion, value: "yes"|"no"|"unsure", note}` appends one
  line to `labels/<set>.jsonl` with the date. Labels are Rishi's own judgments, entered by him;
  nothing else writes them.
- `GET /judge/agreement?set=heldout` is SP5 and returns `null` until then.
