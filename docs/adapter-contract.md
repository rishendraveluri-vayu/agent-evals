# Adapter contract v2

**Status: in force since 4 Nov 2026** (approved as a starting point by Rishi on 3 Nov, R12, and iterated on 4 Nov). v1 was reviewed on paper by Rishi and v2 folds in his notes. `docs/design.md` section 2 points here. The machine-readable form is the JSON Schemas in `contract/v2/`, shared by the API and the workers (SP2). A change to this file changes those schemas in the same commit.

It turns the agreed rules into fields: R10 (adapter rules), R11 (Rishi's review notes), D3 (isolation), D12 (traces, now OpenTelemetry spans), D14 (MCP per trial over stdio), D16 to D24.

## What changed from v1 (Rishi's review, 3 Nov)

1. **Everything is stored and indexed.** The trial folder is only transport. The runner uploads everything to the API before wiping the folder (section 10).
2. **Harness defaults are shown.** Every applied setting records its value and where it came from (sections 4 and 5).
3. **Platform defaults apply only to settings a harness supports.** A harness that cannot honour `parallel_tool_calls` declares it, and its native behaviour is recorded rather than forced (section 3).
4. **Prompts and tool sets are versioned config objects** in the database, so the UI can diff them and an experiment can use them as its axis (section 3, D9).
5. **Adding a harness is cheap.** A shared adapter library does the plumbing, a scaffold command creates the folder, and a probe command writes the "supported" list from evidence (section 4).
6. **Full stdout and stderr are kept**, not a 200-line tail (sections 5 and 10).
7. **Traces are OpenTelemetry spans** (section 6). The minimal trace view and spend chart come in the first end-to-end run.
8. **Effect checks** prove that a setting changes behaviour, not just that it reaches the request (section 8).
9. **The simulated client** gets settings, guards against a yes-man client, and a proof plan (section 9).

## Changed while building it (3 Nov evening, for Rishi's read)

Building the schemas and the shared library turned up these gaps. Each is small, and each is reflected in the sections below and in `contract/v2/`.

1. **`settings_sources` in the spec.** The spec carries resolved values, so it also has to say whether each came from the config or a platform default. Otherwise `applied_settings` could not show the source (section 3).
2. **The simulator's prompt is a versioned text object** (id, version, sha256, text) like the system prompt, and its `base_url` is in the spec. This replaces the bare `prompt_version` (section 9).
3. **`result.conversation` also holds `agent_turns` and the visible `transcript`**, so graders read the whole conversation from one place. `ended_by` is one of `null`, `client`, `turn_cap` or `agent_end_state` (section 5), and since 4 Nov `sim_error` (section 9).
4. **Two more trial-folder files for the reply cache:** `/trial/sim_cache.json` (written by the runner, read-only) and `/trial/out/sim_replies.jsonl` (new replies, for the runner to store). The cache has to outlive the wiped folder (section 2).
5. **`runner-report.json`** is the runner's half of the record: label, exit status, proxy usage, log hashes and the file manifest (sections 5 and 7).
6. **`max_client_turns` counts simulated messages after the opening one**, and the client ends by writing `[[END_CONVERSATION]]` (section 9).
7. **`experiment_id` and `task_split` may be null**, for gate tests and dev runs outside an experiment.
8. **Hermes's `extra_calls_at_limit` is 2, not 1:** when the summary request itself gets a tool call, Hermes retries it once (`docs/research/hermes/sp1_probes.md`).
9. **Each trial key only allows the spec's model**, so a harness cannot quietly call a different one.
10. **LiteLLM facts are now checked** (section 6): spend logs per key, failures included, bodies stored, rows about 1 s after the call.

## Changed after Rishi's review of harness guide v1 (4 Nov evening)

1. **`checks.json`**, written by the runner after every trial: number provenance and required tool calls (section 12, `contract/v2/checks.schema.json`), summarised in `runner-report.json` `checks`.
2. **`task.required_tools`** in the spec, optional (section 3).
3. **The own loop re-sends a cut-off reply once** with the cap doubled (D36, section 5), with an `evals.token_cap_raised` span event (section 6).
4. **The simulator's default prompt is `client-sim.v4`**, v3 plus patience (section 9).

## 1. The shape in one paragraph

For each trial the runner wipes `/trial`, writes `/trial/spec.json` and any seeded state, and starts the adapter as a new process group, with the model key in an environment variable. The adapter, built on the shared adapter library:

- configures its harness from the spec;
- starts the finance MCP server over stdio;
- runs the agent, and the simulated client if the task has one;
- writes spans to `/trial/out/trace.jsonl` as they happen;
- writes `/trial/out/result.json`, and exits.

The runner then:

- merges in LiteLLM's records of every model call for the trial's keys;
- uploads the result, trace, full logs and bodies to the API, which stores and indexes them;
- revokes the keys, kills leftover processes, and wipes the folder.

## 2. Trial folder (D3)

The path is the same in every trial, because Hermes puts paths into its prompt.

| Path | Written by | Holds |
| --- | --- | --- |
| `/trial/spec.json` | runner | The trial spec (section 3). The adapter must not change it. |
| `/trial/state/` | runner | Task state for the finance MCP server, such as `client.json`. |
| `/trial/harness/` | adapter | The harness's own home, for example `HERMES_HOME=/trial/harness/hermes`. |
| `/trial/home/`, `/trial/tmp/` | runner creates | `HOME` and `TMPDIR`. |
| `/trial/out/trace.jsonl` | adapter | OpenTelemetry spans, one per line, flushed as they close (section 6). |
| `/trial/out/result.json` | adapter | Written once at the end, atomically (section 5). |
| `/trial/out/artifacts/` | adapter | Raw harness files worth keeping, such as Hermes's session JSON. |
| `/trial/out/stdout.log`, `stderr.log` | runner | The adapter's full output, captured by the runner. |
| `/trial/sim_cache.json` | runner | Known simulated-client replies for this task and simulator (D22). Read-only. |
| `/trial/out/sim_replies.jsonl` | adapter | New client replies from this trial, for the runner to store: `{key, reply, model, usage}` per line, plus `error` on an empty reply, which is kept for the record and never cached (section 9). |
| `/trial/out/runner-report.json` | runner | The runner's additions: label, exit status, proxy usage, log hashes, file manifest, and a summary of `checks.json`. |
| `/trial/out/checks.json` | runner | Platform checks after every trial: number provenance and required tool calls (section 12). |

Everything else is read-only. Nothing in `/trial` survives to the next trial; everything that matters has been uploaded first (section 10).

## 3. `spec.json`

```json
{
  "contract_version": "2",
  "trial": {
    "id": "t_01J...", "experiment_id": "e_...", "config_id": "c_...", "config_hash": "sha256:...",
    "task_id": "emi-basic-01", "task_version": "sha256:...", "task_split": "discovery",
    "repeat_index": 3, "attempt": 1
  },
  "task": {
    "messages": [{"role": "user", "content": "I took a ₹10 lakh loan at 9% for 20 years ..."}],
    "client_sim": null
  },
  "system_prompt": {"id": "finance-advisor", "version": "v1", "sha256": "...", "text": "..."},
  "model": {
    "name": "claude-haiku-5-5",
    "base_url": "http://litellm:4000/v1",
    "api_key_env": "EVALS_MODEL_API_KEY",
    "api_format": "openai_chat"
  },
  "settings": {
    "temperature": null,
    "max_output_tokens": 8192,
    "max_steps": 15,
    "timeout_s": 300,
    "parallel_tool_calls": null,
    "memory": {"enabled": false},
    "skills": {"enabled": false},
    "compression": {"enabled": false}
  },
  "harness_options": {},
  "tools": {
    "toolset": {"id": "finance", "version": "v1", "sha256": "..."},
    "mcp_servers": [{
      "name": "finance",
      "command": ["/opt/finance-mcp/bin/finance-mcp", "--transport", "stdio", "--state-dir", "/trial/state"],
      "allowed_tools": ["calculate_emi", "amortization_schedule", "..."],
      "tool_timeout_s": 30
    }],
    "enabled_builtins": []
  },
  "seed": {"memory": [], "skills": []}
}
```

- **`settings_sources`** says, for each setting, `config`, `platform_default`, `harness_default` or `unsupported`. The adapter library copies it into `applied_settings`.
- **`settings` is the full, resolved set** (R10.4), filled by the API from the config and the platform defaults. **A platform default is applied only to settings the harness supports.** For an unsupported setting the field is `null`, and the harness's own behaviour is recorded and shown (section 5). A config that explicitly sets an unsupported setting is rejected at submission.
- **An unset setting is not sent (D25).** `temperature` has no platform default: left unset, it is `null` with source `harness_default`, and **every adapter leaves a `null` setting out of every request**, so the harness's or provider's own default applies (the gate test `test_unset_not_sent` checks the wire for each harness). The platform defaults are `max_output_tokens` 8192, `max_steps` 15, `timeout_s` 300, `parallel_tool_calls` false (D19; D25 covers sampling settings only), and `memory`, `skills` and `compression` off. A setting the model refuses (the API's `MODEL_REJECTS` table: `temperature` on `claude-haiku-5-5`, `parallel_tool_calls` on `qwen2.5-7b-local`) cannot be set in a config for that model and is never filled with a default, so it is `null` and never sent.
- **`max_steps` counts the agent's model calls** across the whole trial, conversation included (D17). **`timeout_s`** is enforced by the adapter library's wrapper (R10.6). The runner's safety net is `timeout_s × 1.5 + 30 s` (D23).
- **`parallel_tool_calls`** is a config setting, off by default (D19), so every request carries `parallel_tool_calls: false` unless the config sets `true`. The exception is a model that refuses the field (`qwen2.5-7b-local` through LiteLLM's Ollama route, 5 Nov): there it is `null` and left out, and the model's own behaviour applies.
- **`memory`, `skills` and `compression`** are common settings (D23). Harness detail lives in `harness_options`, validated against the adapter's schema.
- **`system_prompt` and `tools.toolset`** reference versioned config objects stored in the database, with text or manifest, hash, author and date (R11). The UI diffs two versions, and an experiment can vary exactly one of them (D9: prompt v1 versus v2). `allowed_tools` lets a toolset version expose a subset of the finance server's tools, which is how a "missing tool" is represented and later added.
- **`model`**: LiteLLM only (R10.3). The per-trial key is in the environment variable named by `api_key_env`, never `OPENAI_API_KEY` (D23). The adapter passes it explicitly to its model client and starts child processes with a minimal environment that leaves it out.
- **`task.task_split`**: `discovery` or `held_out`, so the prompt experiment can show that the fix works on tasks not used to find the problem (D9).
- **`task.required_tools`** (optional, 4 Nov): tools the agent must call for the task, named as the finance server names them (`["calculate_emi"]`). A grader primitive: the adapter ignores it, and the runner's `checks.json` records which were called and which were missing (section 12). The API copies it from `task.json` and refuses a task that names a tool the server does not have.
- **`seed`**: config-given state in harness-neutral form, written natively by the adapter. It is never learned state (R10.8).

## 4. `capabilities.json` and how a new harness is added

```json
{
  "contract_version": "2",
  "harness": "hermes",
  "version": {"package": "hermes-agent", "ref": "6112c2adb9e11f69734a29be9d2696f345ffa06a"},
  "model_api_formats": ["openai_chat"],
  "settings": {
    "temperature":         {"supported": true,  "native": "request_overrides.temperature", "default": null, "evidence": "probe 2026-11-04"},
    "max_output_tokens":   {"supported": true,  "native": "request_overrides.max_tokens",  "default": null, "evidence": "probe 2026-11-04"},
    "max_steps":           {"supported": true,  "native": "max_iterations", "extra_calls_at_limit": 2},
    "timeout_s":           {"supported": true,  "native": "wrapper"},
    "parallel_tool_calls": {"supported": true,  "native": "request_overrides.parallel_tool_calls"},
    "memory":              {"supported": true},
    "skills":              {"supported": true},
    "compression":         {"supported": true}
  },
  "harness_options_schema": {"type": "object", "additionalProperties": false, "properties": {}},
  "known_differences": ["Tool results wrapped in <untrusted_tool_result> (D20)", "Tool names prefixed mcp__finance__"]
}
```

(The Hermes values are illustrative until the adapter's probes write them.)

**How a new harness is added (R2):**

1. **Scaffold.** `make new-harness NAME=<name>` creates `workers/<name>/` with a Dockerfile (the own loop's, with the new name and module), an adapter stub, a capabilities template, the gate tests and a probe script, and prints the `worker-<name>` service to add to `docker-compose.yml`.
2. **Write two methods** on top of the shared adapter library:
   - `setup(ctx)`: map our settings to the harness's native ones.
   - `run_turn(ctx, history, max_steps)`: run one agent turn and report what happened through the library's span helpers.

   The library does everything else: reading the spec, the timeout wrapper, the MCP command, the conversation loop with the simulated client, error and end-state mapping, writing the result atomically and writing spans. The five adapters are 304 (own loop) to 421 (Hermes) lines; the planning estimate was 100 to 200, and most of the difference is each framework's quirks, recorded in `docs/harness-guide.md`.

3. **Probe.** `make probe-harness NAME=<name>` runs each setting against the fake model server and writes the `supported`, `default` and `evidence` fields from what it actually captured. The file is generated from evidence and committed. Only things a request cannot show, such as memory, are declared by hand. So is `version`: the scaffold writes `{"package": "TODO", "ref": "TODO"}`, and until both name the harness package and its exact version or commit, the API treats the harness as scaffolded, not implemented: `GET /harnesses` leaves it out and `POST /configs` refuses it (`harness_not_implemented`), so no trial for it can wait for a worker that does not exist.
4. **Gate tests and effect checks** (section 8). Then the harness counts.

Uses of the file:

- The API validates every config against it (R10.4).
- The UI shows each harness's defaults from it (R11).
- `known_differences` feeds the invariance diff (D20).
- The runner refuses an adapter whose `contract_version` does not match.

## 5. `result.json`

```json
{
  "contract_version": "2",
  "trial_id": "t_01J...",
  "end_state": "answered",
  "end_detail": {"harness_stop_reason": "stop", "exception_type": null, "exception_message": null, "last_message_excerpt": "..."},
  "final_answer": "Your EMI is ₹8,997.26 ...",
  "conversation": {"agent_turns": 1, "client_turns": 0, "ended_by": null, "transcript": [{"role": "user", "content": "...", "source": "task"}, {"role": "assistant", "content": "...", "source": "agent"}]},
  "harness": {"name": "hermes", "version": "6112c2a", "extra": {}},
  "applied_settings": {
    "temperature":         {"value": 0.2,  "source": "config"},
    "top_p":               {"value": 1.0,  "source": "harness_default"},
    "parallel_tool_calls": {"value": null, "source": "unsupported", "observed": "parallel calls executed in order"}
  },
  "harness_usage": {"model_calls": 6, "input_tokens": 41230, "output_tokens": 1880, "cost_usd": null},
  "counts": {"model_calls": 6, "tool_calls": 4, "tool_errors": 1, "malformed_tool_calls": 0},
  "integrity": {"before": {"config.yaml": "sha256:..."}, "after": {"config.yaml": "sha256:..."}},
  "timing": {"started_at": "2026-11-04T10:00:00Z", "ended_at": "2026-11-04T10:00:41Z", "wall_s": 41.2},
  "artifacts": ["artifacts/hermes-session.json"]
}
```

- **`end_state`** is one of `answered`, `step_limit`, `token_limit`, `timeout`, `agent_error` or `harness_error`. It is **provisional and extensible** (R10.2, R11): new states can be added without breaking old results. `end_detail` keeps the raw signals, so trials can be relabelled later without re-running.
- **`token_limit` on the own loop (D36).** A reply cut off at the cap (`finish_reason: length`) is re-sent once: the same request with `max_tokens` doubled, up to 8,192. The turn span gets an `evals.token_cap_raised` event with `evals.token_cap.first` and `evals.token_cap.raised`, and both calls are in the proxy's `chat` spans. Cut off again, the turn ends as `token_limit` with the partial text. With no cap to raise (none sent, or already 8,192) or no step left for the re-send (it is a model call, D17), it ends as `token_limit` at once; `end_detail.harness_stop_reason` says which. `max_output_tokens` means the first attempt's cap, as on Hermes, and later calls go back to it. The other harnesses end on the first `length`, except Hermes, which raises the cap itself.
- **`applied_settings`** records every setting with its value and **source**: `config`, `platform_default`, `harness_default` or `unsupported`, plus what was observed. The UI shows this (R11).
- **`harness_usage` and `counts`** are the harness's own view, kept for comparison. The truth comes from the proxy (R10.9).
- **`integrity`**: before and after hashes of files the harness can edit with no switch (R10.8).
- **The runner adds, never the adapter:** `proxy_usage` from LiteLLM, the infra or agent label, the attempt history (D16), and full `stdout.log` and `stderr.log` as artifacts.

## 6. `trace.jsonl`: OpenTelemetry spans (D12, amended 3 Nov)

**One trial is one trace.** Each line is one span in the OpenTelemetry (OTLP JSON) span shape:

- `traceId` (derived from the trial id), `spanId`, `parentSpanId`, `name`, `kind`;
- `startTimeUnixNano`, `endTimeUnixNano`;
- `status` (`OK` or `ERROR`);
- `attributes`, and `events`.

Standard tools can read it directly. Our own UI renders it as the trial timeline.

| Span name | Parent | Source | Key attributes |
| --- | --- | --- | --- |
| `invoke_agent <harness>` | none (root) | adapter | `evals.trial.id`, `evals.config.hash`, `evals.task.id`, `evals.end_state` |
| `agent.turn` | root | adapter | turn index. One per agent turn; just one for a single-prompt task. |
| `chat <model>` | turn | **proxy**, merged by the runner | `gen_ai.operation.name=chat`, `gen_ai.request.model`, `gen_ai.request.temperature`, `gen_ai.request.max_tokens`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons`, `evals.attempt`, `evals.proxy.attempts`, `evals.cost_usd`, `evals.request_ref`, `evals.response_ref` |
| `execute_tool <name>` | turn | adapter | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `evals.tool.arguments`, `evals.tool.is_error`, `evals.tool.result_ref` |
| `client_sim.turn` | root | simulator helper | `evals.sim.model`, `evals.sim.cache_hit`, the client's message; on a simulator failure, status `ERROR` and an `evals.error` event (`sim_empty_reply` or `sim_call_failed`, section 9) |

- **Span events** on the turn or root carry `evals.memory.read`, `evals.memory.write`, `evals.skill.load`, `evals.skill.write`, `evals.compression`, `evals.token_cap_raised` (the own loop's re-send on a cut-off reply, D36), and errors with `evals.error.kind` (for example `malformed_tool_call` or `unknown_tool`, D18). These are our extensions, and the reason D12 kept its own attributes. Since 5 Nov `span.schema.json` lists these names: an event whose name starts with `evals.` must be one of them (a typo is reported as a trace error), and any other name stays free. Since 6 Nov the adapter library's span writer also refuses an unlisted `evals.*` name when the adapter emits it (`ValueError`, `evals_adapter.trace.EVENT_NAMES`, kept equal to the schema by a test), so a misspelt event fails the harness's gate tests instead of never reaching the trial page.
- **Model-call spans come from LiteLLM** for every harness (R10.9), so hidden retries appear as extra `chat` spans with `evals.attempt` above 1. An adapter may also emit its own view of a call (`evals.source=adapter`), kept for comparison.
- **LiteLLM's own retries (D16) are not extra spans.** LiteLLM keeps a retried call as one spend-log row and records its retries in `metadata.attempted_retries` (checked 4 Nov on v1.99.4: 429, 429, 200 was one row with 2). So one `chat` span is one request the harness sent, and `evals.proxy.attempts` (1 + `attempted_retries`; 0 for a call refused before routing, such as a budget stop) says how many tries the provider got. The runner report's `proxy_usage` sums them: `model_calls` (harness requests), `attempts` (provider tries) and `retried_calls` (calls tried more than once). "1 harness request, 3 attempts" is `model_calls: 1, attempts: 3`; a harness retry is `model_calls: 2` with `evals.attempt: 2` on the second span. Failed attempts have no row, time or error text of their own; only the last error is kept.
- **Spend is a span attribute**, so it can be plotted per trial, config, task and experiment straight from stored spans.
- Full request and response bodies are stored by reference (section 10). The first request feeds the invariance diff.
- **Checked on 3 Nov** against LiteLLM v1.99.4 and the fake model. `GET /spend/logs?api_key=<token>` returns one row per call, failures included (`status: failure`, with `error_information.error_code`). With `store_prompts_in_spend_logs: true` the bodies are in `proxy_server_request` and `response`, and the stored headers carry no key. With `proxy_batch_write_at: 1` rows usually land about 1 s after the call, but can lag more, so the runner waits for at least the harness's own call count and sets `proxy_usage.complete` false if the log never catches up. Stored strings are cut at about 2,000 characters unless `MAX_STRING_LENGTH_PROMPT_IN_DB` is raised, which compose does; a cut body is flagged on its span. A wildcard route (`fake/*`) priced only in `model_info` logged $0, so prices are also set in `litellm_params`.

## 7. Exit codes and failure mapping

| What happened | Adapter output | Runner label |
| --- | --- | --- |
| A run ended in any way the adapter understood | exit 0, valid `result.json` | agent outcome by `end_state`. Graded, except as the analysis plan says for `timeout`. |
| An error persisted after LiteLLM's retries (D16) | exit 0, `harness_error` with exception detail | `infra:provider_error` if the proxy's last status was 429, 5xx or 408 (LiteLLM's per-call timeout). Re-queued once. |
| The request setup is wrong (D26): a key, an unknown model, a refused setting | exit 0, `harness_error` with exception detail | `infra:config_error` if the proxy's last status was 401, 403 or 404, or a 400 whose error (in `end_detail`) is about authentication, an unknown model or a rejected or unsupported parameter. Never re-queued; the API pauses the experiment. |
| The prompt is over the model's context window | exit 0, `harness_error` | `agent`: a 400 for context too long is the agent's outcome (D26), and so is any 400 that matches neither pattern. |
| A spend safety net tripped | exit 0, `harness_error` | `infra:budget_net`. Never re-queued (D26). Investigate, never routine (R10.6). |
| The adapter crashed, or the result is missing or invalid | non-zero exit | `infra:adapter_crash`. The trace so far and full logs are kept. |
| A safety-net timeout fired | killed (process group, R10.12) | `infra:timeout_kill` |
| The simulated client failed (D26): its call failed, or its reply had no text (section 9) | exit 0, `harness_error`, `conversation.ended_by: sim_error`, the reason in `end_detail` and in an `evals.error` event on the `client_sim.turn` span | `infra:sim_error`, whatever the agent key's status: the agent did not cause it. Re-queued once. Except when the simulator's own key ran out of budget (LiteLLM's record for the simulator key says `budget_exceeded`, or the refusal says the budget was exceeded): `infra:budget_net`, never re-queued (D26). |

Nothing is truncated or dropped. Every trial, including infra failures, keeps its spans, result (if any) and full logs (R11).

**How a provider error is labelled (D26).** `evals_adapter.runner.provider_label` reads LiteLLM's last status for the **agent** key (`proxy_usage.last_status`) and the error the adapter reported (`end_detail.harness_stop_reason` and `exception_message`). The status decides first: a budget stop is `infra:budget_net`; 429, 5xx or 408 (LiteLLM's per-call timeout, D16) `infra:provider_error`; 401, 403 or 404 `infra:config_error`. LiteLLM has already retried every status that reaches this point (D16). For a 400, the message is checked for a context-too-long error first (`agent`), then for a setup error (`infra:config_error`); both pattern lists are in `runner.py`. With no LiteLLM record the label stays `agent`.

**The order the runner labels in** (`evals_adapter.runner.label`): a kill is `infra:timeout_kill`; a non-zero exit or a missing or invalid result is `infra:adapter_crash`; a result with `conversation.ended_by: sim_error` is `infra:budget_net` when the simulator's key ran out of budget and `infra:sim_error` otherwise; then a `harness_error` gets D26's provider labels above; anything else is `agent`. The tests use the exact 4 Nov messages: the unscoped-key 400 ("This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header ...") and the temperature 400 ("`temperature` is deprecated for this model"), as the own loop, Hermes and the Agents SDK reported them.

## 8. Gate tests and effect checks (R7, R10.5, D24)

**Gate tests.** All run through LiteLLM against the fake model server, with no real calls:

1. **Settings test.** Each supported setting appears in the captured request, and an unset `temperature` or `parallel_tool_calls` (null, `harness_default`) does not appear at all (D25).
2. **Step test.** A script that keeps calling tools ends in `step_limit`, and the proxy's call count is no more than `max_steps` plus the declared extra.
3. **Tool test.** The first request's `tools` array, normalised, equals the toolset snapshot apart from the declared rewrites.
4. **Timeout test.** A `timeout` fault gives `end_state: timeout` within `timeout_s` plus a small margin.
5. **Error test.** A malformed tool call is handled as D18 says. The harness never retries a 429 itself (R10.11): straight against the fake it sends one request; through LiteLLM it still sends one, while LiteLLM makes 4 attempts behind it (D16). The proxy-mode tests also check that a call failing twice (429 or 503) recovers with 3 attempts and the trial answers, that an always-503 call ends `infra:provider_error` after 4, and that a 400 gets 1 attempt and ends `infra:config_error`.
6. **Conversation test.** A simulated task runs a three-turn conversation with the simulator routed to a scripted fake model.
7. **Schema test.** `result.json` and every span validate against the v2 schemas.

**Effect checks (D24).** These prove that a setting *changes behaviour*, not just that it arrives. They use a cheap real model (Haiku 5.5 and a Gemini Flash), run once per harness and model at gate time, and each run is signed off with a cost estimate first (R8):

| Setting | Check |
| --- | --- |
| `temperature` | 5 samples at 0 and 5 at 1 on a prompt with room for variety. Outputs should differ only at 1. |
| `max_output_tokens` | A small cap ends the reply with `finish_reason: length`. |
| `parallel_tool_calls` | When on, a task needing two independent calculations gets both calls in one turn. When off, one per turn. |
| `memory` | A seeded fact the task needs is used when memory is on, and not when off. |

A setting that reaches the request but changes nothing is recorded as **inert** for that harness and model. The capabilities file and the UI say so.

A harness counts once the gate tests pass and its effect checks have run, by its R7 deadline of Thursday 12:00. (In the event the effect checks were not run for any harness; all five count on their gate, drift and probe evidence, and `docs/known-limits.md` says what that leaves unproven.)

## 9. Simulated client (D22)

A task with no `client_sim` block is a single prompt. With one, a second model plays the client:

```json
"client_sim": {
  "persona": "Meera, 41, Pune. Widowed in March; her husband's ₹18 lakh home loan is now in her name ...",
  "client_summary": "Profile:\n- name: Meera ...\nDebts (1, total balance ₹18,00,000.00, ...):\n- Home loan: balance ₹18,00,000.00 at 8.5% a year, ...",
  "hidden_facts": ["Monthly take-home ₹92,000", "₹6 lakh in an FD she has not touched"],
  "concerns": ["Can I keep the house?", "Should I use the FD to prepay?"],
  "goal": "Understand whether she can keep the house and what to do first",
  "opening_message": "I don't really know where to start. My husband handled all of this.",
  "max_client_turns": 3,
  "model": {"name": "claude-haiku-5-5", "base_url": "http://litellm:4000/v1", "api_key_env": "EVALS_SIM_API_KEY", "temperature": null, "max_output_tokens": 2048,
            "prompt": {"id": "client-sim", "version": "v2", "sha256": "...", "text": "..."}}
}
```

(The persona is an invented illustration, not a task.)

- **The prompt** is a versioned file, `configs/prompts/client-sim.v<n>.md`, and the API's default is the highest version: `client-sim.v4.md` since 4 Nov. v2 (D27) added the client file and chat-only text, v3 (D30) the latest month's transactions and a concrete end rule, and v4 patience (Rishi's review note 16): after two advisor replies in a row that give nothing on the main concern and only ask questions, the client says plainly that it wants an answer, and if the next reply also gives nothing it ends the conversation unhappy, with the end marker. Earlier versions are kept unchanged for runs that used them. The library fills `{{persona}}`, `{{client_summary}}`, `{{hidden_facts}}`, `{{concerns}}`, `{{goal}}` and `{{end_marker}}` (`evals_adapter.sim.render_prompt`; a template without a placeholder ignores that value).
- **`client_summary` (D27, optional)** is a short summary of the task's client file, built by the API from the task's `client_state` (`apps/api/src/worker/client-summary.ts`): the profile as recorded, and the debts with their balances, rates, minimum payments and totals as the finance tools write them. Transactions are left out. The field is absent when the task has no client file. It is part of the reply-cache key when present.
- **`model.temperature` (D27) is optional.** Null or absent means it is not sent, so the model's default applies. The API sends none for a simulator model that refuses temperature (Haiku 5.5, from the `MODEL_REJECTS` table) and D22's 0 otherwise; the reply cache gives repeatability.

- **The conversation loop lives once, in the shared adapter library.** Each harness only implements `run_turn(ctx, history, max_steps)` within one process, using its native session: Hermes passes the history back in, ADK keeps one session id, the Agents SDK carries the input list, LangGraph appends messages, and the Claude SDK uses a multi-turn client. **Not yet run** (R11: "not sure this works"), so it is proven first on Hermes and the own loop in the conversation test. The fallback for any harness that fails is to re-send the full transcript each turn as fresh input.
- **What the client sees:** only the agent's visible replies, not tool calls or results, plus its own client summary, so it never contradicts the records the tools return (D27). It reveals a hidden fact only when the agent asks for it. Graders know every fact.
- **How the client writes (D27):** only the words it would type in a chat, as the client. No narration, no stage directions, no actions between asterisks or brackets.
- **Guarding against a yes-man client** (R11: "the problem is yes man"):
  - The simulator prompt sets behaviour rules: stay in the emotional state, never volunteer facts, push back on generic or irrelevant advice, ask again if confused, never praise advice that misses the concerns. v2 keeps v1's wording for each.
  - The client ends once its concerns have been answered in a way it can act on, or it has what it came for (D27), and otherwise asks about what is still open; the turn cap is the backstop.
  - If Haiku proves too agreeable, the simulator model can be changed in config.
  - **Rishi reviews about 10 simulator transcripts** before the experiment, like a small judge validation, and the simulator prompt is versioned.
  - Simulated tasks stay a small share of the set, about 5 to 8, because each needs a persona and this review.
- **Simulator settings** (model, temperature, token cap, prompt version) are configurable, recorded in every trial, and identical across all configs in an experiment, which the invariance check enforces. The API's token cap is 2048 (`SIM_MAX_OUTPUT_TOKENS`, 4 Nov): Haiku 5.5's reasoning counts towards it, and at 300 it took the whole cap and left the reply empty.
- **One set of responses where the conversation is the same.** Client replies are cached by task, simulator settings and exact visible transcript. The agent's calls are never cached.
- **Ending.** The client ends by writing `[[END_CONVERSATION]]`; `max_client_turns` counts simulated messages after the opening one. The conversation ends when the client sends the marker (its concerns answered, or it has what it came for), at `max_client_turns`, or when the simulator fails (below). The agent's last reply is graded, and `max_steps` and `timeout_s` cover the whole conversation.
- **A failed or empty simulator turn is a simulator failure, never a client ending (D26, 4 Nov).** On 4 Nov Haiku 5.5 spent the simulator's whole 300-token cap on reasoning (`reasoning_tokens: 300, text_tokens: 0`) and returned an empty reply; the library took that as the client ending, so three conversations stopped after one agent turn and were labelled `agent`. Now (`evals_adapter.sim.empty_reply`):
  - A turn is a **simulator failure** when the call fails (no connection, an HTTP error, a response with no message or not JSON) or the reply has no text once the marker is taken out, with or without the marker.
  - The one exception: **the marker alone, once the client has already sent a message of its own** in this conversation, is a normal client ending (its goodbye came in that earlier message). The library cannot tell whether that earlier message really was a goodbye (`docs/assumptions.md` A10).
  - A failure ends the conversation with `ended_by: sim_error` and `end_state: harness_error`. `end_detail` has `harness_stop_reason: simulator_error`, `exception_type: SimulatorError` and the reason in `exception_message`, with the finish reason and the output and reasoning token counts when the response gives them. The `client_sim.turn` span ends in `ERROR` with an `evals.error` event whose `evals.error.kind` is `sim_empty_reply` or `sim_call_failed`. The runner labels the trial `infra:sim_error` (section 7), and the API re-queues it once.
  - An empty reply is still written to `sim_replies.jsonl`, raw and with its usage, so a reply that went entirely to reasoning stays visible. Its row carries `error`, and it is never cached, by the library or by the API, so the re-queued attempt asks the simulator again. A cached reply that is empty (from before this rule) is a failure too.
  - Examples: `contract/v2/examples/result-sim-error.json` and `runner-report-sim-error.json`. Tests: `workers/adapterlib/tests/test_sim_error.py`, with the fake model server's `sim-empty` and `sim-client` scripts.

## 10. Storage and traceability (R11)

The trial folder is transport only. Before wiping it, the runner uploads everything to the API, and the folder is wiped only after the API confirms. The API keeps:

- **one trial row**, indexed by experiment, config hash, prompt version, toolset version, task, split, harness, model, end state and infra label;
- **`result.json`** as structured data;
- **every span**, indexed by trial, span name, tool name and status, so the UI can draw the timeline and plot spend and latency without re-reading files;
- **artifacts:** full stdout and stderr, request and response bodies, and harness files, stored by content hash and referenced from spans. Logs are capped at 50 MB, and anything cut is flagged as truncated.
- **Nothing is ever deleted or overwritten** (CLAUDE.md). A re-run is a new attempt row.

The exact tables are SP2's data model, **[Rishi designs]**.

## 11. Decided on 3 Nov

1. Config shape: memory, skills and compression are common settings, with harness detail in `harness_options` (D23).
2. Safety-net timeout: `timeout_s × 1.5 + 30 s` (D23).
3. Simulated client: supported (D22), with the guards in section 9.
4. Per-trial key: an environment variable, named in the spec (D23).
5. Traces: OpenTelemetry spans (D12, amended).
6. Effect checks at gate time (D24).
7. Headline experiment: prompt v1 versus v2 on discovery and held-out tasks (D9).

## 12. Platform checks after every trial: `checks.json` (4 Nov)

Rishi's review notes 21 and 31: "if an agent shows a calculation without a tool call, should flag error or at the minimum highlight", and "if EMI was never calculated, grader will not flag issue". After every trial, whatever its label, the runner runs `evals_adapter.checks` and writes `/trial/out/checks.json` (schema `contract/v2/checks.schema.json`) before the file manifest, so it is listed in `runner-report.json` `files` and uploaded with the rest. The report's `checks` entry says whether the file validated, how many amounts were unsupported and which required tools were missing. A failure of the checks themselves is recorded there (`path: null`) and never changes the label. Run it on any finished trial folder with `python -m evals_adapter.checks <trial-dir>`.

```json
{"contract_version": "2", "trial_id": "t_01J...",
 "amounts": [{"turn": 0, "text": "₹4.41 lakh", "value": 441000, "supported_by": "tool",
              "match": {"value": 441000, "where": "tool:list_debts", "how": "exact", "precision": 1000, "call": 0},
              "rejected": null}],
 "unsupported": 0, "tools_called": ["list_debts"],
 "required_tools": {"required": ["list_debts"], "called": ["list_debts"], "missing": [], "only_errors": []},
 "arithmetic": []}
```

`contract/v2/examples/checks-arithmetic.json` shows the arithmetic fields (D56, below): a sum from `add` that is supported, and a `round` of a figure no source holds, which is not.

**Number provenance.**

- **Amounts** are taken from every agent reply in `result.conversation.transcript`: a number with ₹, Rs, Rs. or INR before it or "rupees" after it; one with lakh, lac or crore after it (`₹4.41 lakh` is ₹4,41,000); one written in Indian grouping from one lakh up (`4,41,050`); and a bare number right after a marked amount in a range (`₹8,000–9,000`). k, thousand, million and L (`₹1.2L`) scale a marked amount. Percentages, months, years and plain numbers are not money.
- **Sources**, in order of preference: `tool`, every number in an `execute_tool` span's `evals.tool.result` from the same agent turn or an earlier one; `client`, every number in the files of `/trial/state` (the task's client file); `user`, every number in a task or simulated-client message before the reply. Dates (`2026-10-25`), URLs (since D58, 5 Nov: `reference_rates` cites press releases such as `...?prid=63742`) and numbers glued to letters (`t001`) are skipped; a lakh or crore word scales the number before it (`"11.59 lakh"` is 11,59,000). A tool match names its call in `match.call`: its position among the trial's `execute_tool` spans in start order, from 0.
- **Arithmetic tools** (D56, 5 Nov): the result of `add`, `subtract`, `multiply`, `divide`, `percent_of`, `percent_change` or `round` (with or without Hermes's `mcp__finance__`) is a `tool` source only when the call returned no error, was given at least one number, and every number in its `evals.tool.arguments` (round's `places` aside) is itself supported: by a non-arithmetic tool result or an accepted arithmetic result from an earlier call, the client file, or a user message up to the call's turn. An input is matched by the amounts' rule below, at the digits it was written with (`8997` matches 8,997.26 rounded). Calls are traced in start order, so a chain (add, then subtract on its result, then round) is supported when its first inputs are, and breaks where a made-up figure enters. **Unit facts and the identity guard (D58, 5 Nov):** an input equal to 7, 12, 28, 29, 30, 31, 52, 100, 365, 366, 1,00,000 or 1,00,00,000 (`UNIT_FACTS`, by value, sign ignored) needs no source, and is listed with `supported_by: "unit"` and `match: null` when nothing else matched it, so `multiply([emi, 12])` and `divide(annual, 365)` count when the other input does; 0 and 1 never are. A result that only repeats an input with no source (by the amounts' rule, with the result at the digits it was returned with as the amount) never counts, whatever the list says: `round(365)`, `add([100, 0])`, `multiply([12, 1])` (`"round's result 365.00 only repeats its input 365, which has no source"`). Unit facts are arithmetic inputs only: an amount in a reply still needs a source. `arithmetic` lists every such call with each input's match and, when the result does not count, a `reason` (`"add's input 12,345 is not supported"`, `"round returned an error"`, `"divide's arguments could not be read"`). An amount with no other source that matched such a result has it in `rejected`, with the reason, so the trial page can say why. Every other tool's result counts as before, whatever its inputs. The fields are additive: a checks.json from before 5 Nov has no `arithmetic`, `rejected` or `match.call` and still validates.
- **A match** is the amount at the precision it is written in: `exact`, `rounded` half-up, or `truncated` to the digits shown. "About ₹8,997" matches 8997.26, "₹1,667" matches 1667.50, "₹1.23 lakh" matches 1,23,456. Trailing zeros in a whole amount can also be rounding (`rounded`, with a coarser `precision`) when two significant digits remain and the number is within 1% of the amount: "about ₹49,500" matches 49,483.43, "₹31,000" does not match 31,330.07. The best match wins: exact, then rounded, truncated and trailing-zero rounding, and then tool, client, user.
- **Verify, don't trace** (D61, 5 Nov; A44 has the exact rule): each amount records `verified_by`: `source` (it matches a number in a source, above), `tool` (it matches the result of an arithmetic call that counts) or `derived_in_prose` (the checker recomputed it, with `supported_by: "derived"`, `match: null` and the `derivation`: `op`, `operands` with where each came from, `value` and `how`). A derivation is one step: a sum or difference of a figure the answer wrote (verified) and another written figure or a sourced amount (a sourced number of 100 or more); a sourced amount or written figure times or divided by 12 or a count the answer writes ("3 months", "24 EMIs"); a percentage of one at a rate the answer states or a source holds; the sum of a run of 3 to 8 verified figures written next to it; or a repeat of a figure derived earlier. It must match at the precision written (not the 1% trailing-zeros rule). Since D61 an arithmetic call counts when each input is sourced or a free factor (a unit fact, a whole number from 1 to 60, a percentage the replies state), `add`, `subtract`, `percent_change` and `round` have a source for every input, at least one input is a sourced amount, and the identity guard passes. `derived_in_prose` at the top counts the figures written without a tool, and `runner-report.json`'s `checks` repeats it with `amounts`, for the comparison's per-arm measure.
- **`unsupported`** counts amounts with `supported_by: null`: a figure the agent worked out itself (a sum of transactions, the difference between two plans, a month's interest), one it picked as an example, or one it passed through an arithmetic tool without a source for the inputs. It is a highlight for a reader and the judge, not a verdict; `docs/known-limits.md` lists how it can be wrong. A wrong sum is unsupported.
- **On the 4 Nov real run** (`runs/20261104T083111Z-real/`, Haiku 5.5, five harnesses, read-only): 230 amounts in 10 trials with replies; every amount in the five single-prompt answers was backed by a tool result, and 34 in the five conversations were not (0 on ADK, 5 on the own loop, 7 on LangGraph, 8 on Hermes, 14 on the Agents SDK). `workers/adapterlib/tests/test_checks.py` pins the list.

**Required tool calls.** With `task.required_tools` in the spec, `required_tools` lists the required names, those `called` (at least one `execute_tool` span), those `missing`, and those whose every call returned an error (`only_errors`). Names are compared without a harness prefix (Hermes's `mcp__finance__`). `tools_called` lists every tool the agent called, once, in first-call order. Without `required_tools`, `required_tools` is null.

**Graders read it** (`graders/`, since framework 0.2.0; the arithmetic rule since 0.4.0; unit facts and the identity guard since 0.5.0; D61's verification and the `derived_in_prose` count since 0.6.0): the `provenance` grader fails a trial with more unsupported amounts than its `max_unsupported`, and the `required_tools` grader fails one with a missing required tool. On a checks.json from before D56 (no `arithmetic`) where an amount's match is an arithmetic tool's result, the `provenance` grader cannot tell whether its inputs were supported: it fails the trial when the other unsupported amounts already exceed the cap, and is an `error` otherwise (`docs/proposals/grader-format.md`). A `tool_called` grader is the other way to require a tool, from the spans, with argument checks (`docs/proposals/grader-format.md` says which to use when).
