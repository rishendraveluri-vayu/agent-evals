# fake-llm

A fake OpenAI-compatible Chat Completions server for tests and CI. In tests, LiteLLM routes
model calls here instead of to a real provider, so no test spends money or needs an API key.

It does three jobs:

1. **Scripted replies.** Deterministic text and tool calls, so end-to-end runs repeat exactly.
2. **Forced faults.** 429, 500, timeout, broken stream, malformed tool call and a reply cut off
   at the token cap (`length`), on demand, so retry, timeout and infra-failure handling can be
   tested reliably.
3. **Request capture.** Every request body is kept, so tests can check what actually reached
   the model: `temperature`, `max_tokens`, the `tools` array, the system prompt.

## Run

```sh
uv sync
uv run fake-llm                      # serves on :8080, loads ./scripts
docker build -t agent-evals/fake-llm:dev .
docker run --rm -p 8080:8080 agent-evals/fake-llm:dev
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `FAKE_LLM_PORT` | `8080` | Port to listen on (binds `0.0.0.0`). |
| `FAKE_LLM_SCRIPTS_DIR` | `./scripts` | Script folder. If set, it must exist. If unset and `./scripts` is missing, only `default` loads. |

Run one worker only. Fault counters and the capture live in process memory.

## Endpoints

| Method and path | Purpose |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat Completions, `stream: false` or `true`. Also at `/chat/completions`. |
| `GET /v1/models` | Every script name as a model, `default` included. Also at `/models`. |
| `GET /health` | `200 {"status":"ok"}` |
| `GET /_fake/requests[?script=name]` | Captured requests, oldest first, newest last. Ring buffer of 2000. |
| `DELETE /_fake/requests` | Clear the capture. Returns `{"cleared": n}`. |
| `GET /_fake/scripts` | Scripts with their source (`builtin`, `file:<name>`, `runtime`) and definitions. |
| `POST /_fake/scripts` | Register or replace a script. Body has the same shape as a file, and `name` is required. 201 if new, 200 if replaced, 400 if invalid. |
| `DELETE /_fake/faults` | Reset every `times` counter. Returns `{"cleared": n}`. |

Errors use OpenAI's shape: `{"error": {"message", "type", "param", "code"}}`.

Each capture entry has these fields:

- `seq`: never restarts, even after a clear.
- `ts` (epoch seconds) and `time` (ISO 8601 UTC).
- `script`: the resolved script.
- `requested_script`, `selected_by` (`marker`, `model` or `default`) and `fell_back`.
- `step`: the step index served.
- `stream`.
- `fault`: the kind that fired, or `null`.
- `outcome`: `pending`, `completed`, `client_disconnected` or `connection_dropped`.
- `body`: the full JSON body.

Headers are not captured, because they can carry keys.

## Choosing a script

The fake checks these in order, and the first one that names a script decides:

1. **A marker** `[[fake-script:<name>]]`. The fake looks for it in the first system (or
   developer) message and in the first user message. It reads string content or text parts.
2. **The `model` field**, taking the part after the last `/`. So `fake/echo`,
   `openai/fake/echo` and `echo` all select `echo`.
3. **The built-in `default`**, which returns a short fixed text and never calls tools.

If the name it found is unknown, the fake serves `default` and sets `fell_back: true` in the
capture. An unknown marker does not go on to try the model name. You cannot replace `default`.

## Script format

A script is a YAML (`.yaml`, `.yml`) or JSON file in the scripts folder. The file name is the
script name. A `name` key is optional, but if you include one it must match the file name. The
fake rejects unknown keys, so typos fail at startup.

```yaml
description: Calls search_docs, then answers.   # optional
steps:
  - tool_calls:
      - name: search_docs
        arguments: {query: "refund policy"}    # object, or a raw string sent as-is
  - text: "Refunds are accepted within 30 days."
    delay_ms: 200                              # optional latency before responding
    chunk_delay_ms: 20                         # optional gap between stream chunks
```

- **Which step is served.** The step index is the number of `assistant` messages already in
  the request, so no session state is kept. Once the conversation runs past the last step, the
  fake serves the last step again.
- **What a step contains.** A step has `text`, `tool_calls`, or both. With both, the content
  comes first, then the tool calls, and `finish_reason` is `tool_calls`. Inside `text`, the
  placeholder `{{last_user_message}}` is replaced by the last user message's text.
- **Tool names.** A scripted name that is not in the request's `tools` is matched to the one
  tool whose name ends with `__<name>`, so `calculate_emi` becomes Hermes's
  `mcp__finance__calculate_emi` and one script serves every harness. With no match, or more
  than one, the name is sent as scripted.
- **Tool-call ids.** They are deterministic: `call_` plus 24 hex characters of
  sha256(script, step, position). The same step always gets the same ids.
- **Token counts.** Usage is deterministic: `ceil(chars / 4)`. Prompt tokens count the
  canonical JSON of `messages`, plus `tools` when the request has them. Completion tokens count
  the content plus each tool name and its argument string. A reply cut by the `length` fault
  reports the request's `max_tokens` (or `max_completion_tokens`) as its completion tokens
  when the request sets one, as a provider does for a reply that ran into its cap.
- **Fields that change on every response.** The completion `id` and `created` are different
  each time, so anything keyed on the response id never collides.

Example scripts: `echo`, `two-tools`, `rate-limited` and `flaky-stream`. For the harness gate tests: `finance-emi` (one finance tool call, then an answer) and `finance-loop` (a tool call on every step, never an answer). For the platform's number-provenance check and the graders: `finance-emi-unsupported` (as `finance-emi`, plus a yearly figure the reply works out itself, which no tool returned). For LiteLLM's retries (D16): `finance-429` (always 429), `finance-429-twice` and `finance-503-twice` (the first call fails twice, then the `finance-emi` flow), `finance-503` (always 503) and `finance-400` (always 400, worded like Haiku 5.5's rejected-temperature error). For the own loop's retry on a cut-off reply (D36): `finance-length` (a tool call, then an answer cut off at the cap once and served whole when the same request is sent again) and `finance-length-always` (the answer is cut off every time). For the simulated client: `sim-client` (two client replies, then the end marker) and `sim-empty` (a reply with no text, as Haiku 5.5 gave when its whole token cap went to reasoning; the adapter library must call it a simulator failure).

## Faults

Any step can carry a `fault`. It fires on every attempt unless you set `times: n`, in which case
it fires on the first `n` identical attempts and after that the step is served normally.
Identical means the same sha256 of (script, step index, canonical JSON of `messages`), so a
retry of the same request counts as the same attempt. The counter is exact under concurrent
requests. Clear it with `DELETE /_fake/faults`.

| `kind` | Behaviour |
| --- | --- |
| `429` | 429 with an OpenAI rate-limit error. Sends `Retry-After: ceil(retry_after)` and `retry-after-ms`. `retry_after` defaults to 1 second and may be fractional. |
| `500` | 500 with an OpenAI `server_error` body. |
| `400`, `401`, `403`, `404` | That status with an OpenAI `invalid_request_error` body (`invalid_api_key` code for 401, `model_not_found` for 404). |
| `502`, `503` | That status with a `server_error` body. The 503 says "This model is currently experiencing high demand. Please try again later", as Gemini did on 4 Nov, and sends no `Retry-After`. |
| `timeout` | Sleeps `seconds` (default 30), then serves the step normally. The sleep stops early if the client disconnects, so abandoned requests do not pile up. |
| `broken_stream` | **Streaming:** sends the role chunk and the first half (rounded up) of the content or argument chunks, then closes the TCP connection. There is no `finish_reason`, no usage chunk and no `[DONE]`. For a tool-call step, the client gets the tool-call header and part of the arguments. **Non-stream:** sends a `Content-Length` for the full body, sends half of it, then closes. Either way the client sees a protocol error; the official openai client raises `APIConnectionError`. |
| `malformed_tool_call` | Tool-call arguments that are not valid JSON (the closing `}` is dropped), on every call in the step. The step must have `tool_calls`. |
| `length` | The reply stops at the output token cap: the first half (rounded up) of the step's text, no tool calls, and `finish_reason: length` (also in the last stream chunk). The step must have non-empty `text`. With `times: 1`, the same messages sent again get the whole step, whatever the new `max_tokens`. |

`kind` can be written `429` or `"429"`. The status faults (400 to 503) respond before any stream
starts, as OpenAI does, and take an optional `message` that replaces the default error text (for
example a provider's own 400 wording). A step whose status fault always fires (no `times`) may
omit `text` and `tool_calls`.

A broken connection makes uvicorn log `ASGI callable returned without completing response.`
at ERROR level. That line is expected.

## Streaming shape

Chunks are `data: {json}\n\n` and the stream ends with `data: [DONE]`. They arrive in this
order:

1. A role chunk.
2. Content in 8-character fragments.
3. For each tool call, a header delta with `index`, `id`, `type`, `function.name` and empty
   `arguments`, then deltas that carry only `index` and an argument fragment.
4. A final chunk with an empty delta and `finish_reason`.

With `stream_options: {include_usage: true}`, every chunk has `usage: null` except one last
chunk before `[DONE]`, which has `choices: []` and the usage.

## Not modelled

The fake does not do any of the following:

- honour `n` (it always returns one choice);
- enforce `max_tokens`: a reply is cut off (`finish_reason: length`) only by the `length`
  fault, never because of the cap's value;
- read `tool_choice`;
- check that the tools it calls are in the request's `tools`;
- check authentication.

## Tests and lint

```sh
uv run pytest                  # about 4 s; starts a real uvicorn server on a free port
uv run ruff check .            # uses the repo-root ruff.toml
uv run ruff format --check .
```

The tests use only this server. Most use Starlette's in-process TestClient with a fresh app per
test. One real uvicorn server on a free port covers what TestClient cannot show: client
timeouts, dropped connections, real concurrency, and the official `openai` client.
