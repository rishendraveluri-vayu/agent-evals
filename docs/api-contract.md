# Control-plane API contract (SP2, SP3, SP7)

Status: 4 Nov 2026. Built on R14 (data model) and D2 (workers only claim and report over HTTP).
Three streams build against this file in parallel: the NestJS API, the Python worker, and the
Vue UI. Change it only by editing this file in the same commit as the code.

All bodies are JSON. Times are RFC 3339 UTC. Money is USD as a number. Hashes are
`sha256:<hex>`. Errors are `{"error": "<code>", "message": "<plain words>"}` with a 4xx/5xx
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
  is a 400 `unsupported_setting` naming it), fills `settings_sources`, and computes
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
- `POST /experiments/:id/start`, `POST /experiments/:id/cancel` (queued trials become
  `cancelled`; running ones finish).
- `GET /experiments` returns `[{id, name, axis, status, config_hashes, n, counts, spend_usd,
  estimate, created_at}]`, where `counts` is `{queued, running, done, infra_failed,
  abandoned, cancelled}` and done is split by label.
- `GET /experiments/:id` adds `tasks`, `configs`, `events` (claims, infra failures,
  re-queues, budget trips, newest first).
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

A worker serves one harness. Its loop: claim, run, heartbeat while running, report.

1. `POST /worker/claim` with `{worker_id, harness}`. Returns 204 when nothing is queued for
   that harness, or 200 with
   `{trial_id, attempt, spec, state_files: {"client.json": "<base64>"}, keys: {model, sim},
   budgets: {trial_usd, sim_usd}, lease_s: 60}`. `spec` is a complete contract v2 spec whose
   `model.base_url` is LiteLLM as seen from the worker. The claim is one `UPDATE ... WHERE id
   = (SELECT ... FOR UPDATE SKIP LOCKED)`, so two workers never get the same trial.
2. `POST /worker/trials/:id/heartbeat` with `{worker_id, attempt}` every 10 s. 200 keeps the
   lease; 409 `claim_lost` means the API gave up on it (stop the trial, report nothing).
3. `GET /worker/trials/:id/calls?role=agent|sim` returns LiteLLM's spend-log rows for that
   trial's key, as LiteLLM returns them. The worker's runner polls this the way it polls
   LiteLLM today (`ProxyClient.call_records`) and merges the rows into its spans.
4. `POST /worker/trials/:id/report` with `{worker_id, attempt, runner_report, result, spans,
   files: [{path, bytes, sha256}]}`. The trial folder itself is on the shared `runs` volume
   at `runs/<experiment_id>/<trial_id>/attempt-<n>/`; the API checks the hashes. Reporting the
   same attempt twice is a no-op 200. The API revokes the trial's keys, stores the report,
   and sets the status: `done` for an `agent` label; for an `infra:*` label, `infra_failed`
   and, if this was attempt 1, a new `queued` attempt 2 (D16: re-queued once, never twice).
5. A lease with no heartbeat for 60 s lapses: the API marks the attempt `abandoned`, revokes
   its keys, and queues the next attempt under the same cap.

## UI-only endpoints

- `GET /labels/queue?set=tuning|heldout|final` returns blind items `{item_id, task_summary,
  transcript, tool_calls, criteria}` with no harness, model, arm, timing, cost or grade.
- `POST /labels` with `{item_id, set, criterion, value: "yes"|"no"|"unsure", note}` appends one
  line to `labels/<set>.jsonl` with the date. Labels are Rishi's own judgments, entered by him;
  nothing else writes them.
- `GET /judge/agreement?set=heldout` is SP5 and returns `null` until then.
