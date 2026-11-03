# Claude Agent SDK (Python): fit check against the adapter contract

Docs-only check, 3 Nov 2026, for R2's test case "adding the Claude Agent SDK tomorrow should be simple". Not built. Items marked [unverified] were not confirmed in the docs.

**Verdict.** It fits a one-process-per-trial adapter (`python adapter.py spec.json` writing `result.json` and `trace.jsonl`), with three gaps: no temperature option, no wall-clock timeout, and a trace that has to be assembled from the SDK stream plus the proxy's logs.

## 1. Running a task
`query()` for one task; `ClaudeSDKClient` is for multi-turn sessions. The Python package bundles a native Claude Code binary and spawns it over stdio, so no Node.js and no separate CLI install. `cli_path` overrides the binary. Sources: [quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart.md), [hosting](https://code.claude.com/docs/en/agent-sdk/hosting.md), [python](https://code.claude.com/docs/en/agent-sdk/python.md).

## 2. Proxy
`env={"ANTHROPIC_BASE_URL": ..., "ANTHROPIC_API_KEY": key}` (or `ANTHROPIC_AUTH_TOKEN`, sent as Bearer). The proxy must speak the Anthropic Messages format (`POST /v1/messages`; `count_tokens` optional) and forward `anthropic-beta` and `anthropic-version`. Chat Completions is not a listed format ([gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol.md)). Set the key explicitly: a base URL alone leaves a saved claude.ai login active ([gateway](https://code.claude.com/docs/en/llm-gateway.md)). LiteLLM's `/v1/messages` behaviour against our fake server is [unverified].

## 3. Settings
- `model`: yes. Unrecognised model IDs get a 32k default output cap.
- Temperature: **no option**; `temperature`, `top_p` and `max_tokens` have no fields ([configuration](https://code.claude.com/docs/en/agent-sdk/configuration.md)).
- Max output tokens: only the env var `CLAUDE_CODE_MAX_OUTPUT_TOKENS` ([env vars](https://code.claude.com/docs/en/env-vars.md)).
- `max_turns`: yes; counts tool rounds plus the final text turn. Hitting it yields `error_max_turns`, then `query()` raises.
- Timeout: **no session timeout**. `API_TIMEOUT_MS` covers response headers only; the stream idle watchdog defaults to 300000 ms. The runner must enforce wall-clock time and kill the process group.
- `thinking` and `effort` exist; set them explicitly. `max_budget_usd` exists but is a client-side estimate.

## 4. Tools
- `disallowed_tools=[...]` removes built-in tool definitions from the request. `"*"` removes every tool including MCP, so list built-ins by name (Agent, Skill, WebFetch, WebSearch, ToolSearch and so on).
- Allow only ours with `allowed_tools=["mcp__<server>__*"]` plus `permission_mode="dontAsk"`; `allowed_tools` alone restricts nothing. Do not use the bypass permission mode, which the docs say `allowed_tools` does not constrain ([permissions](https://code.claude.com/docs/en/agent-sdk/permissions.md)).
- `mcp_servers` takes stdio, `http` and `sse`. Tool names become `mcp__<server>__<tool>` ([mcp](https://code.claude.com/docs/en/agent-sdk/mcp.md)). Set `strict_mcp_config=True` so claude.ai connectors do not load.

## 5. State and isolation
With `setting_sources` omitted the SDK loads user, project and local settings, CLAUDE.md, and `.claude` skills, agents and commands; `~/.claude.json` and auto memory load regardless. The documented multi-tenant recipe: `setting_sources=[]`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `CLAUDE_CONFIG_DIR` per trial, explicit `cwd`; also `skills=[]` and `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`. Each `query()` is a new session unless `resume` or `continue_conversation` is passed. `env` merges over the inherited environment, so the container must not carry `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. Whether a per-trial LiteLLM key triggers a server-managed settings fetch is [unverified].

## 6. Observability and usage
Stream: `SystemMessage` init (tools, MCP status), `AssistantMessage` per content block, `UserMessage` with tool results, optional `StreamEvent`, then `ResultMessage` (subtype, result, `num_turns`, `usage`, `total_cost_usd`, `model_usage`). Hooks (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, ...) are available; they do not fire when `max_turns` ends the session. Per-message `output_tokens` is a placeholder; totals are on `ResultMessage.usage`. Telemetry: set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, leave `CLAUDE_CODE_ENABLE_TELEMETRY` unset.

## 7. Failures
`error_max_turns` and `error_max_budget_usd` are yielded, then `query()` raises; these are limits, not infra failures. The CLI retries 429/500/529 up to `CLAUDE_CODE_MAX_RETRIES` (default 10); retries are real duplicate requests visible at the proxy but not in the SDK stream ([errors](https://code.claude.com/docs/en/errors.md)). After retries run out the process exits non-zero; the exact result subtype is [unverified].

## 8. Risks for an adapter
1. **Trace independence.** No raw request or response bodies, invisible retries, placeholder output counts. Use the proxy's logs for model calls and the SDK stream for tool calls.
2. **Hidden inputs.** CLAUDE.md, memory, connectors, global config, managed settings and the bundled CLI can leak in. Test that the init message lists only our MCP tools.
3. **Unhonourable settings and version drift.** No temperature, no timeout; output cap via env var; the bundled CLI changes with the SDK version. Pin the SDK, record the CLI version, mark unsupported settings explicitly.
