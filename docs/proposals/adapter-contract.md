# Adapter contract v1: proposal

**Status: proposal for Rishi, 3 Nov 2026. Not approved.** Once approved it moves into `docs/design.md` section 2 and becomes JSON Schemas shared by the API and the workers (SP2).

It turns the agreed rules into fields: R10 (adapter rules), D3 (isolation), D12 (traces), D14 (MCP per trial over stdio), D16 to D20. Every field below traces to one of them. Anything not traced is marked **(choice)** for review.

## 1. The shape in one paragraph

For each trial the runner wipes `/trial`, writes `/trial/spec.json` and any seeded state, and starts the adapter as a new process group. The adapter configures its harness from the spec, starts the finance MCP server over stdio, runs the agent, appends events to `/trial/out/trace.jsonl` as they happen, writes `/trial/out/result.json`, and exits. The runner then merges in LiteLLM's records of every model call for the trial's key, reports to the API, revokes the key, kills leftover processes and wipes the folder.

## 2. Trial folder (D3)

The path is the same in every trial, because Hermes puts paths into its prompt.

| Path | Written by | Holds |
| --- | --- | --- |
| `/trial/spec.json` | runner | The trial spec (section 3). The adapter must not change it. |
| `/trial/state/` | runner | Task state for the finance MCP server, such as `client.json`. |
| `/trial/harness/` | adapter | The harness's own home, for example `HERMES_HOME=/trial/harness/hermes`, or `CLAUDE_CONFIG_DIR`. |
| `/trial/home/`, `/trial/tmp/` | runner creates, harness uses | `HOME` and `TMPDIR`. |
| `/trial/out/trace.jsonl` | adapter | Events, appended and flushed as they happen (section 6). |
| `/trial/out/result.json` | adapter | Written once at the end, atomically: temp file, then rename (section 5). |
| `/trial/out/artifacts/` | adapter, optional | Raw harness files worth keeping, such as Hermes's session JSON. |

Everything else is read-only (D3). Nothing in `/trial` survives to the next trial.

## 3. `spec.json`

```json
{
  "contract_version": "1",
  "trial": {
    "id": "t_01J...", "experiment_id": "e_...", "config_id": "c_...", "config_hash": "sha256:...",
    "task_id": "emi-basic-01", "task_version": "sha256:...", "repeat_index": 3, "attempt": 1
  },
  "task": {
    "messages": [{"role": "user", "content": "I took a ₹10 lakh loan at 9% for 20 years ..."}]
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
    "mcp_servers": [{
      "name": "finance",
      "command": ["/opt/finance-mcp/bin/finance-mcp", "--transport", "stdio", "--state-dir", "/trial/state"],
      "tool_timeout_s": 30
    }],
    "enabled_builtins": []
  },
  "seed": {"memory": [], "skills": []}
}
```

How each part follows from the rules:

- **`settings` is the full, resolved set** (R10.4). The API fills every platform setting before the trial starts, so an adapter never falls back silently on its own default. `null` means "not set by the config": the adapter then leaves the harness default and records it in `applied_settings`. A config that sets something the harness does not support never reaches a spec, because the API rejects it at submission.
- **`max_steps` counts the agent's model calls** across the whole trial (D17). **`timeout_s`** is enforced by the adapter's wrapper (R10.6). The runner's safety net is `timeout_s × 1.5 + 30 s` (Rishi, 3 Nov).
- **`parallel_tool_calls`** defaults to false (D19).
- **`memory`, `skills` and `compression`** are common settings, because R3 and R10.8 need them visible on every config (Rishi, 3 Nov). Harness-specific detail, such as Hermes's nudge intervals, lives in `harness_options`.
- **`harness_options`** is opaque to the platform. Each adapter validates it against a schema in its capabilities file. This is the "small common block plus per-harness options" shape from the pre-mortem.
- **`model`** points only at LiteLLM, with a per-trial key (R10.3). `api_format` is `openai_chat` for every harness today. The Claude Agent SDK would need `anthropic_messages`, which is why the field exists.
- **`tools`**: the finance MCP server, started per trial over stdio (D14), with an explicit tool timeout, because ADK and the Agents SDK default to 5 s. `enabled_builtins` is empty unless a config turns a built-in on (R10.7). That is also where the parked "tools beyond MCP" idea would plug in.
- **`seed`** is state the config gives the agent at the start, in harness-neutral form: memory as a list of text entries, skills as files. The adapter writes it in its harness's native format. It is never learned state (R10.8).
- **`task.messages`** is a list, so a task can supply earlier turns. A task may also carry a `client_sim` block, which turns it into a conversation with a simulated client (section 9; Rishi chose this on 3 Nov).
- **The per-trial key travels as an environment variable** (Rishi, 3 Nov). The spec carries only its name, `EVALS_MODEL_API_KEY`, never `OPENAI_API_KEY`, which would switch on the Agents SDK's tracing export. The adapter passes the key explicitly to its model client and, where the harness allows, starts child processes (the MCP server, CLIs) with a minimal environment that leaves it out.

## 4. `capabilities.json` (one per adapter, fixed)

```json
{
  "contract_version": "1",
  "harness": "hermes",
  "version": {"package": "hermes-agent", "ref": "6112c2adb9e11f69734a29be9d2696f345ffa06a"},
  "model_api_formats": ["openai_chat"],
  "settings": {
    "temperature":         {"supported": true, "native": "request_overrides.temperature"},
    "max_output_tokens":   {"supported": true, "native": "request_overrides.max_tokens"},
    "max_steps":           {"supported": true, "native": "max_iterations", "note": "one extra summary call at the limit"},
    "timeout_s":           {"supported": true, "native": "wrapper"},
    "parallel_tool_calls": {"supported": true, "native": "request_overrides.parallel_tool_calls"},
    "memory":              {"supported": true},
    "skills":              {"supported": true},
    "compression":         {"supported": true}
  },
  "harness_options_schema": {"type": "object", "additionalProperties": false, "properties": {}},
  "known_differences": [
    "Tool results wrapped in <untrusted_tool_result> (D20)",
    "Tool names prefixed mcp__finance__"
  ]
}
```

(The Hermes values above are illustrative until SP1 confirms them.)

- **The API validates every config against this file** (R10.4).
- **The gate tests are generated from it** (R10.5): one settings test per supported setting, plus the tool test.
- **`known_differences`** lists the prompt and tool changes the harness makes. It feeds the invariance diff (D20) and the tool test's allowed rewrites.
- The runner refuses an adapter whose `contract_version` does not match.

## 5. `result.json`

```json
{
  "contract_version": "1",
  "trial_id": "t_01J...",
  "end_state": "answered",
  "end_detail": {
    "harness_stop_reason": "stop",
    "exception_type": null,
    "exception_message": null,
    "last_message_excerpt": "..."
  },
  "final_answer": "Your EMI is ₹8,997.26 ...",
  "harness": {"name": "hermes", "version": "6112c2a", "extra": {}},
  "applied_settings": {"temperature": 0.2, "max_output_tokens": 1024, "max_steps": 15, "...": "..."},
  "harness_defaults_used": ["top_p"],
  "harness_usage": {"model_calls": 6, "input_tokens": 41230, "output_tokens": 1880, "cost_usd": null},
  "counts": {"model_calls": 6, "tool_calls": 4, "tool_errors": 1, "malformed_tool_calls": 0},
  "integrity": {"before": {"config.yaml": "sha256:..."}, "after": {"config.yaml": "sha256:..."}},
  "timing": {"started_at": "2026-11-04T10:00:00Z", "ended_at": "2026-11-04T10:00:41Z", "wall_s": 41.2},
  "artifacts": ["artifacts/hermes-session.json"]
}
```

- **`end_state`** is one of `answered`, `step_limit`, `token_limit`, `timeout`, `agent_error` or `harness_error`. **Provisional** (R10.2): the list is expected to grow finer.
- **`end_detail`** keeps the raw harness signals, so finer labels can be derived later without re-running.
- The adapter never says pass or fail (R10.2).
- **`harness_usage` and `counts`** are the harness's own view, kept only for comparison. The truth comes from the proxy (R10.9).
- **`integrity`** holds the before and after hashes of files the harness can edit with no switch: Hermes's `config.yaml`, `SOUL.md` and `AGENTS.md` (R10.8). It is empty for harnesses with none.
- **`harness_defaults_used`** lists settings the harness applied that the config left unset.

**What the runner adds, never the adapter:**
- `proxy_usage`, taken from LiteLLM;
- the infra or agent label;
- the attempt history (D16);
- the last 200 lines of stderr.

## 6. `trace.jsonl` (D12)

One JSON object per line. The common fields are `seq`, `ts`, `trial_id`, `source` (`adapter` or `proxy`), `type`, `id` and `parent_id`. Field names follow OpenTelemetry's `gen_ai.*` names where one exists. Our own concepts use `evals.*`.

| `type` | Source | Key fields |
| --- | --- | --- |
| `run_start`, `run_end` | adapter | `end_state` on `run_end` |
| `model_call` | **proxy**, merged by the runner | `gen_ai.request.model`, `gen_ai.request.temperature`, `gen_ai.request.max_tokens`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons`, `latency_ms`, `status`, `attempt`, `request_ref`, `response_ref` |
| `model_output` | adapter | What the harness received: text and tool calls (`gen_ai.tool.call.id`, `gen_ai.tool.name`, arguments) |
| `tool_call` | adapter | `gen_ai.tool.name`, `gen_ai.tool.call.id`, `arguments` |
| `tool_result` | adapter | `gen_ai.tool.call.id`, `is_error`, `content`, `duration_ms` |
| `error` | adapter | `kind` (for example `malformed_tool_call` or `unknown_tool`, D18), `message`, `recovered` |
| `memory_read`, `memory_write`, `skill_load`, `skill_write`, `compression` | adapter | `evals.*` fields. These are why D12 chose our own schema. |
| `final` | adapter | `final_answer` |

- **Model calls come from LiteLLM** for every harness (D12, R10.9), so hidden retries show up as extra `model_call` rows with `attempt` above 1.
- An adapter may also emit its own `model_call` with `source: adapter` when its hooks expose one. Both are kept for comparison.
- Full request and response bodies are stored by reference, not inline, because they are large. The first request's body feeds the invariance diff.
- **To verify in SP1:** that LiteLLM can store request and response bodies in its spend logs (`store_prompts_in_spend_logs`), and that the runner can match them to a trial by key.

## 7. Exit codes and failure mapping

| What happened | Adapter output | Runner label |
| --- | --- | --- |
| A run ended in any way the adapter understood | exit 0, valid `result.json` | agent outcome by `end_state`. Graded, except as the analysis plan says for `timeout`. |
| An error persisted after LiteLLM's retries (D16) | exit 0, `harness_error` with exception detail | `infra:provider_error` if the proxy's last status was 429 or 5xx. Re-queued, capped. |
| A spend safety net tripped | exit 0, `harness_error` | `infra:budget_net`. Investigate, never routine (R10.6). |
| The adapter crashed, or the result is missing or invalid | non-zero exit | `infra:adapter_crash`. The trace so far and stderr are kept. |
| A safety-net timeout fired | killed (process group, R10.12) | `infra:timeout_kill` |

stdout is ignored, because ADK and LiteLLM print banners there. stderr's tail goes into the report for debugging.

## 8. Gate tests every adapter must pass (R7, R10.5)

All run through LiteLLM against the fake model server, with no real calls.

1. **Settings test.** For each supported setting, check that the captured request carries the value: `temperature`; `max_tokens` or `max_completion_tokens`; `parallel_tool_calls`.
2. **Step test.** A script that keeps calling tools must end with `end_state: step_limit`, and the proxy's call count must be no more than `max_steps` plus any declared extra.
3. **Tool test.** The first request's `tools` array, normalised, must equal the finance manifest snapshot apart from the rewrites the capabilities file declares.
4. **Timeout test.** A `timeout` fault must give `end_state: timeout` within `timeout_s` plus a small margin.
5. **Error test.** A `malformed_tool_call` fault must be handled as D18 says. A 429 fault must be retried at LiteLLM and invisible to the harness.
6. **Schema test.** `result.json` and every trace line must validate against the v1 schemas.

A harness counts once these pass, by its R7 deadline of Thursday 12:00.

## 9. Simulated client (draft; open points marked **(choice)**)

Rishi chose on 3 Nov to support a simulated client: a second model plays the client and answers the agent mid-run. A task with no `client_sim` block stays a single prompt.

```json
"client_sim": {
  "persona": "Meera, 41, Pune. Widowed in March; her husband's ₹18 lakh home loan is now in her name ...",
  "hidden_facts": ["Monthly take-home ₹92,000", "₹6 lakh in an FD she has not touched"],
  "goal": "Understand whether she can keep the house and what to do first",
  "opening_message": "I don't really know where to start. My husband handled all of this.",
  "max_client_turns": 3,
  "model": {"name": "claude-haiku-5-5", "api_key_env": "EVALS_SIM_API_KEY", "temperature": 0}
}
```

(The persona above is an invented illustration, not a task.)

- **The adapter runs the conversation** inside one trial, using its harness's own multi-turn session, because R10.1 keeps one process per trial. Between agent turns it calls a shared, harness-neutral simulator helper shipped in the worker image (like the finance MCP server). The helper takes the visible transcript and returns the next client message or a stop signal, so the simulator is byte-identical across harnesses.
- **What the simulated client sees:** only the agent's visible replies, not tool calls or results. It knows the persona and hidden facts, and reveals a fact only when the agent asks for it **(choice)**.
- **The simulator model** is fixed per experiment and the same for every config, and its calls use their own key, so the agent's call counts, spend and step limit stay clean **(choice)**.
- **The conversation ends** when the simulator signals it is done, or after `max_client_turns`; the agent's last reply is the final answer **(choice)**.
- **Simulated and single-prompt tasks can coexist** in one task set; which tasks the experiment uses is part of D9 **(choice)**.
- **Trace:** `user_message` events with `source: simulator`, and simulator model calls recorded from the proxy under their own key, tagged `role: simulator`.
- **Gate tests:** one simulated task per adapter, with the simulator routed to a scripted fake model.

## 10. Decided on 3 Nov

1. Config shape: memory, skills and compression are common settings, with harness detail in `harness_options`.
2. Safety-net timeout: `timeout_s × 1.5 + 30 s`.
3. Simulated client: supported (section 9; open points still to settle).
4. Per-trial key: an environment variable, named in the spec.
