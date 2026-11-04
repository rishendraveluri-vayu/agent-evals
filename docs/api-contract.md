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
  (R10.3 tightened; D2).
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

- `POST /configs` with `{name, harness, model, prompt_sha256, toolset_sha256, settings, harness_options, parent_hash}`.
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

  It then computes
  `hash = sha256(canonical JSON of harness ref, adapter version, capabilities sha256, model,
  prompt sha256, toolset sha256, settings, harness_options)`. Posting the same content twice
  returns the same config (200, not a duplicate).

  **Refusals carry a fix** (D25 follow-up, Rishi's guide review item 1). Every 400 for a refused
  setting has a `fix` the Config screen shows by the field:

  | `error` | When | `fix`, for example |
  | --- | --- | --- |
  | `unsupported_setting` | the model refuses it | "Claude Haiku 5.5 rejects temperature: leave it unset, or pick a model that takes it." |
  | `unsupported_setting` | the harness cannot take it (the message quotes the capabilities file's reason) | "ownloop ignores memory: leave it unset, or pick a harness that takes it (hermes)." |
  | `invalid_setting` | a bad value | "Set max_steps to an integer of at least 1, or leave it unset for the default." |
  | `unknown_setting` | a name that is not a setting | "Did you mean temperature? Rename temprature to temperature." |
  | `invalid_harness_options`, `unknown_harness`, `unknown_model`, `unknown_prompt`, `unknown_toolset` | | where to pick a valid one |

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
  prompt, toolset, settings, settings_sources, unsupported, warnings, harness_options,
  parent_hash, created_at}`. `unsupported` and `warnings` are worked out from the stored
  capabilities, so every read has them, not only the POST. `GET /configs/:hash` adds
  `children: [{hash, name, created_at}]`, the configs forked from it, oldest first.
- `GET /configs/:a/diff/:b` returns `[{path, a, b}]`: every field that differs (`unsupported`,
  `warnings` and `parent_hash` are left out: derived, or not behaviour).

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
  temperature is `null` and not sent (D27); the token cap is 300. `sim` in the experiment shows
  all three.
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
  | `POST /experiments/:id/start` | `created`, `paused` | starts it, or resumes it (as `/resume`); marks it `done` if nothing is left to claim |
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
- **Automatic pauses (D32).** Checked after every report and every lapsed lease, only while the
  experiment is `running`. Each pauses the whole experiment with an event whose `detail` is the
  `paused_reason`; resume or stop after review. None of them looks at the difference between the
  arms: the verdict uses the full planned N, so nothing stops or decides on an apparent win.
  - **Futility**, `futility: {enabled, after, min_passed}` on `POST /experiments` (left out:
    `{enabled: true, after: 3, min_passed: 1}`; `{"enabled": false}` turns it off; shown resolved
    as `futility` in the detail). Once per arm: when the arm has `after` finished (`done`) trials,
    it pauses the run if fewer than `min_passed` of them passed. Event `futility_pause`, for
    example "futility check (D32): arm B passed 0 of its first 3 finished trials, fewer than the 1
    the rule asks for (passed means label agent and end state answered until graders exist
    (SP4)) ...". Until graders exist (SP4), **passed means label `agent` and end state
    `answered`**. The first batch is a random sample because of the claim order. An arm whose
    trials are reused from the parent is not checked.
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
  estimate, created_at}]`, where `counts` is `{queued, running, done, infra_failed,
  abandoned, cancelled}` and done is split by label.
- `GET /experiments/:id` adds `tasks`, `configs`, `arms`, `order_seed`, `paused_at`,
  `paused_reason` and `events`, newest first: `[{at, kind, trial_id, attempt, arm, config_hash,
  detail}]`. Claims, infra failures, config errors, re-queues, budget trips, abandons and file
  problems come from the trial rows; pauses and resumes (`paused`, `resumed`, `arm_paused`,
  `arm_resumed`, `futility_pause`, `infra_guard_pause`, `spend_guard_pause`) and the `baseline`
  decision are stored as they happen.
- `GET /experiments/:id/trials?status=&config=&task=` returns trial summaries.
- `GET /experiments/:id/compare` returns `{experiment_id, status, reason, arms, rows, stats}`.
  **No comparison until every arm is complete** (D37, D32): while `status` is `incomplete`,
  `reason` says why ("arm B is paused: ...", "the experiment was stopped before every trial ran
  (...); a verdict needs the full planned N (D32)", "the experiment is paused: ...", "arm A has 3
  trials queued or running", "the experiment has not been started") and `rows` is empty, so no
  pass counts are shown off a partial run. Once `complete`, `rows` holds per task and arm `{task,
  task_id, arm, config, config_name, passed, graded, trials, infra_failed, abandoned}` and, once
  SP6 exists, the intervals and verdict. Until then `stats` is `null`.
- `GET /experiments/:id/export?format=json|csv` streams trials joined with configs, tasks,
  grades and spend.

## Trials

- `GET /trials/:id` returns `{id, experiment_id, task, config, repeat_index, attempt, status,
  label, end_state, result, runner_report, usage, timing, files: [{path, bytes, sha256}],
  grades: []}`.
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

   `sim_cache` (D22) is `{<cache key>: <reply>}`: every simulator reply stored so far for the
   same task (sha256), simulator model, temperature (a `null` one, not sent, is its own scope),
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
   another model, is left out and noted in `problems`. The response's `sim_replies_stored`
   counts the replies added. Reporting the same attempt twice
   is a no-op 200. The API revokes the trial's keys, stores the report, and sets the status:
   `done` for an `agent` label; for an `infra:*` label, `infra_failed` and, if this was
   attempt 1, a new `queued` attempt 2 (D16: re-queued once, never twice), except for the two
   labels that are never re-queued (D26): `infra:config_error`, which also pauses its arm
   (D37), and `infra:budget_net`. `infra:provider_error`, `infra:adapter_crash` and
   `infra:timeout_kill` are re-queued once.
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
