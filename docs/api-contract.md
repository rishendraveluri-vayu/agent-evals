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
model). `client_state` names a file next to `task.json` that the runner places in the trial's
state folder for the finance MCP server.

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
  | `temperature`, `parallel_tool_calls` | `null`: not sent, so the harness's or provider's default applies (D25) | `harness_default` |
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

## Experiments

- `POST /experiments/estimate` with `{config_hashes, task_sha256s, n, sim_model}` returns
  `{trials, cost_usd: {expected, low, high}, minutes, basis}`. `basis` says where per-trial
  tokens came from: the mean of earlier finished trials of the same config and task when
  there are any, otherwise the assumptions in `docs/cost.md` (64k input, 2.4k output per
  trial). Prices come from LiteLLM. No power estimate yet; SP6 adds `min_detectable_effect`.
- `POST /experiments` with `{name, axis, config_hashes, task_sha256s, n, sim_model,
  budget_usd, plan_commit}` creates the experiment and all its trial rows (`queued`), records
  the platform commit (`EVALS_PLATFORM_COMMIT`), and sets a LiteLLM budget for the whole
  experiment. It returns the experiment. Nothing runs until it is started.
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
   same task (sha256), simulator model, temperature, token cap and simulator prompt, from any
   earlier trial, experiment or harness. Keys are `evals_adapter.sim.cache_key`, which hashes
   those same values plus the visible transcript, so one key is one conversation state. It is
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
   labels that are never re-queued (D26): `infra:config_error`, which also pauses the
   experiment, and `infra:budget_net`. `infra:provider_error`, `infra:adapter_crash` and
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
