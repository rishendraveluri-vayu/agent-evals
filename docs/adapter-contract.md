# Adapter contract v2

**Status: approved as a starting point by Rishi on 3 Nov 2026 (R12), to be iterated on 4 Nov.** v1 was reviewed on paper by Rishi and v2 folds in his notes. `docs/design.md` section 2 points here. The machine-readable form is the JSON Schemas in `contract/v2/`, shared by the API and the workers (SP2). A change to this file changes those schemas in the same commit.

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
3. **`result.conversation` also holds `agent_turns` and the visible `transcript`**, so graders read the whole conversation from one place. `ended_by` is one of `null`, `client`, `turn_cap` or `agent_end_state` (section 5).
4. **Two more trial-folder files for the reply cache:** `/trial/sim_cache.json` (written by the runner, read-only) and `/trial/out/sim_replies.jsonl` (new replies, for the runner to store). The cache has to outlive the wiped folder (section 2).
5. **`runner-report.json`** is the runner's half of the record: label, exit status, proxy usage, log hashes and the file manifest (sections 5 and 7).
6. **`max_client_turns` counts simulated messages after the opening one**, and the client ends by writing `[[END_CONVERSATION]]` (section 9).
7. **`experiment_id` and `task_split` may be null**, for gate tests and dev runs outside an experiment.
8. **Hermes's `extra_calls_at_limit` is 2, not 1:** when the summary request itself gets a tool call, Hermes retries it once (`docs/research/hermes/sp1_probes.md`).
9. **Each trial key only allows the spec's model**, so a harness cannot quietly call a different one.
10. **LiteLLM facts are now checked** (section 6): spend logs per key, failures included, bodies stored, rows about 1 s after the call.

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
| `/trial/out/sim_replies.jsonl` | adapter | New client replies from this trial, for the runner to store. |
| `/trial/out/runner-report.json` | runner | The runner's additions: label, exit status, proxy usage, log hashes, file manifest. |

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
    "temperature": 0.2,
    "max_output_tokens": 1024,
    "max_steps": 15,
    "timeout_s": 300,
    "parallel_tool_calls": false,
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

- **`settings_sources`** says, for each setting, `config`, `platform_default` or `unsupported`. The adapter library copies it into `applied_settings`.
- **`settings` is the full, resolved set** (R10.4), filled by the API from the config and the platform defaults. **A platform default is applied only to settings the harness supports.** For an unsupported setting the field is `null`, and the harness's own behaviour is recorded and shown (section 5). A config that explicitly sets an unsupported setting is rejected at submission.
- **`max_steps` counts the agent's model calls** across the whole trial, conversation included (D17). **`timeout_s`** is enforced by the adapter library's wrapper (R10.6). The runner's safety net is `timeout_s × 1.5 + 30 s` (D23).
- **`parallel_tool_calls`** defaults to false where supported (D19).
- **`memory`, `skills` and `compression`** are common settings (D23). Harness detail lives in `harness_options`, validated against the adapter's schema.
- **`system_prompt` and `tools.toolset`** reference versioned config objects stored in the database, with text or manifest, hash, author and date (R11). The UI diffs two versions, and an experiment can vary exactly one of them (D9: prompt v1 versus v2). `allowed_tools` lets a toolset version expose a subset of the finance server's tools, which is how a "missing tool" is represented and later added.
- **`model`**: LiteLLM only (R10.3). The per-trial key is in the environment variable named by `api_key_env`, never `OPENAI_API_KEY` (D23). The adapter passes it explicitly to its model client and starts child processes with a minimal environment that leaves it out.
- **`task.task_split`**: `discovery` or `held_out`, so the prompt experiment can show that the fix works on tasks not used to find the problem (D9).
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

1. **Scaffold.** `make new-harness NAME=<name>` creates `workers/<name>/` with a Dockerfile, an adapter stub, a capabilities template and the gate tests.
2. **Write two functions** on top of the shared adapter library:
   - `apply_settings(spec)`: map our settings to the harness's native ones.
   - `run_turn(history)`: run one agent turn and report what happened through the library's span helpers.

   The library does everything else: reading the spec, the timeout wrapper, the MCP command, the conversation loop with the simulated client, error and end-state mapping, writing the result atomically and writing spans. The expected size is 100 to 200 lines per harness. Hermes will be larger, because of what it has to have neutralised (`docs/hermes-notes.md`).

3. **Probe.** `make probe-harness NAME=<name>` runs each setting against the fake model server and writes the `supported`, `default` and `evidence` fields from what it actually captured. The file is generated from evidence and committed. Only things a request cannot show, such as memory, are declared by hand.
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
| `chat <model>` | turn | **proxy**, merged by the runner | `gen_ai.operation.name=chat`, `gen_ai.request.model`, `gen_ai.request.temperature`, `gen_ai.request.max_tokens`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons`, `evals.attempt`, `evals.cost_usd`, `evals.request_ref`, `evals.response_ref` |
| `execute_tool <name>` | turn | adapter | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `evals.tool.arguments`, `evals.tool.is_error`, `evals.tool.result_ref` |
| `client_sim.turn` | root | simulator helper | `evals.sim.model`, `evals.sim.cache_hit`, the client's message |

- **Span events** on the turn or root carry `evals.memory.read`, `evals.memory.write`, `evals.skill.load`, `evals.skill.write`, `evals.compression`, and errors with `evals.error.kind` (for example `malformed_tool_call` or `unknown_tool`, D18). These are our extensions, and the reason D12 kept its own attributes.
- **Model-call spans come from LiteLLM** for every harness (R10.9), so hidden retries appear as extra `chat` spans with `evals.attempt` above 1. An adapter may also emit its own view of a call (`evals.source=adapter`), kept for comparison.
- **Spend is a span attribute**, so it can be plotted per trial, config, task and experiment straight from stored spans.
- Full request and response bodies are stored by reference (section 10). The first request feeds the invariance diff.
- **Checked on 3 Nov** against LiteLLM v1.99.4 and the fake model. `GET /spend/logs?api_key=<token>` returns one row per call, failures included (`status: failure`, with `error_information.error_code`). With `store_prompts_in_spend_logs: true` the bodies are in `proxy_server_request` and `response`, and the stored headers carry no key. With `proxy_batch_write_at: 1` rows usually land about 1 s after the call, but can lag more, so the runner waits for at least the harness's own call count and sets `proxy_usage.complete` false if the log never catches up. Stored strings are cut at about 2,000 characters unless `MAX_STRING_LENGTH_PROMPT_IN_DB` is raised, which compose does; a cut body is flagged on its span. A wildcard route (`fake/*`) priced only in `model_info` logged $0, so prices are also set in `litellm_params`.

## 7. Exit codes and failure mapping

| What happened | Adapter output | Runner label |
| --- | --- | --- |
| A run ended in any way the adapter understood | exit 0, valid `result.json` | agent outcome by `end_state`. Graded, except as the analysis plan says for `timeout`. |
| An error persisted after LiteLLM's retries (D16) | exit 0, `harness_error` with exception detail | `infra:provider_error` if the proxy's last status was 429 or 5xx. Re-queued, capped. |
| A spend safety net tripped | exit 0, `harness_error` | `infra:budget_net`. Investigate, never routine (R10.6). |
| The adapter crashed, or the result is missing or invalid | non-zero exit | `infra:adapter_crash`. The trace so far and full logs are kept. |
| A safety-net timeout fired | killed (process group, R10.12) | `infra:timeout_kill` |

Nothing is truncated or dropped. Every trial, including infra failures, keeps its spans, result (if any) and full logs (R11).

## 8. Gate tests and effect checks (R7, R10.5, D24)

**Gate tests.** All run through LiteLLM against the fake model server, with no real calls:

1. **Settings test.** Each supported setting appears in the captured request.
2. **Step test.** A script that keeps calling tools ends in `step_limit`, and the proxy's call count is no more than `max_steps` plus the declared extra.
3. **Tool test.** The first request's `tools` array, normalised, equals the toolset snapshot apart from the declared rewrites.
4. **Timeout test.** A `timeout` fault gives `end_state: timeout` within `timeout_s` plus a small margin.
5. **Error test.** A malformed tool call is handled as D18 says. A 429 is retried at LiteLLM and invisible to the harness.
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

A harness counts once the gate tests pass and its effect checks have run, by its R7 deadline of Thursday 12:00.

## 9. Simulated client (D22)

A task with no `client_sim` block is a single prompt. With one, a second model plays the client:

```json
"client_sim": {
  "persona": "Meera, 41, Pune. Widowed in March; her husband's ₹18 lakh home loan is now in her name ...",
  "hidden_facts": ["Monthly take-home ₹92,000", "₹6 lakh in an FD she has not touched"],
  "concerns": ["Can I keep the house?", "Should I use the FD to prepay?"],
  "goal": "Understand whether she can keep the house and what to do first",
  "opening_message": "I don't really know where to start. My husband handled all of this.",
  "max_client_turns": 3,
  "model": {"name": "claude-haiku-5-5", "base_url": "http://litellm:4000/v1", "api_key_env": "EVALS_SIM_API_KEY", "temperature": 0, "max_output_tokens": 300,
            "prompt": {"id": "client-sim", "version": "sim-v1", "sha256": "...", "text": "..."}}
}
```

(The persona is an invented illustration, not a task.)

- **The conversation loop lives once, in the shared adapter library.** Each harness only implements `run_turn(history)` within one process, using its native session: Hermes passes the history back in, ADK keeps one session id, the Agents SDK carries the input list, LangGraph appends messages, and the Claude SDK uses a multi-turn client. **Not yet run** (R11: "not sure this works"), so it is proven first on Hermes and the own loop in the conversation test. The fallback for any harness that fails is to re-send the full transcript each turn as fresh input.
- **What the client sees:** only the agent's visible replies, not tool calls or results. It reveals a hidden fact only when the agent asks for it. Graders know every fact.
- **Guarding against a yes-man client** (R11: "the problem is yes man"):
  - The simulator prompt sets behaviour rules: stay in the emotional state, never volunteer facts, push back on generic or irrelevant advice, ask again if confused, never praise advice that misses the concerns.
  - The client may end only when every listed `concern` has been addressed, or at the turn cap.
  - If Haiku proves too agreeable, the simulator model can be changed in config.
  - **Rishi reviews about 10 simulator transcripts** before the experiment, like a small judge validation, and the simulator prompt is versioned.
  - Simulated tasks stay a small share of the set, about 5 to 8, because each needs a persona and this review.
- **Simulator settings** (model, temperature, token cap, prompt version) are configurable, recorded in every trial, and identical across all configs in an experiment, which the invariance check enforces.
- **One set of responses where the conversation is the same.** Client replies are cached by task, simulator settings and exact visible transcript. The agent's calls are never cached.
- **Ending.** The client ends by writing `[[END_CONVERSATION]]`; `max_client_turns` counts simulated messages after the opening one. The conversation ends when the client's concerns are covered or at `max_client_turns`. The agent's last reply is graded, and `max_steps` and `timeout_s` cover the whole conversation.

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
