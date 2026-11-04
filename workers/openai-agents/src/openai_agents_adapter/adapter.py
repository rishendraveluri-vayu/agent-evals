"""The OpenAI Agents SDK harness (openai-agents 0.24.0) on the shared adapter library.

The SDK runs as it comes: one plain `Agent` with the task's system prompt as `instructions`, the
finance MCP server over stdio, and `Runner.run`. Each switch below is set because the SDK's
default would break a fair comparison (docs/research/harnesses/openai-agents-sdk.md):

- Chat Completions through LiteLLM: a model *instance* (`OpenAIChatCompletionsModel`), never a
  model string, which would route to the Responses API (and give gpt-5* names hidden settings).
- Tracing off, and the OpenAI exporter removed: by default the SDK posts traces, prompts
  included, to api.openai.com. Our trace comes from the hooks below and from LiteLLM.
- Retries zero in both layers: the openai client (`max_retries=0`) and the runner
  (`ModelRetrySettings(max_retries=0)`). LiteLLM is the only retry layer (D16, R10.11).
- MCP: the spec's per-call timeout (the SDK default is 5 s), schemas left as the server sent them
  (`convert_schemas_to_strict` off), only the spec's allowed tools.
- D18: an unknown tool goes back to the model (`tool_not_found_behavior`) instead of raising.
  Malformed arguments already go back, as the SDK's fixed text; that text is kept and recorded.

Earlier turns of a conversation are carried the SDK's own way: `result.to_input_list()` plus the
new user message. No session object, so nothing persists outside this process.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import importlib.metadata
import json
import threading
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any

import openai
from agents import (
    Agent,
    ModelSettings,
    OpenAIChatCompletionsModel,
    RunConfig,
    RunHooks,
    Runner,
    set_trace_processors,
    set_tracing_disabled,
)
from agents.exceptions import MaxTurnsExceeded, ModelBehaviorError
from agents.mcp import MCPServerStdio, create_static_tool_filter
from agents.retry import ModelRetrySettings
from evals_adapter import Adapter, TrialContext, TurnResult, main

IMPLEMENTED = True

# Before anything can create a trace: no spans, and no exporter to api.openai.com.
set_trace_processors([])
set_tracing_disabled(True)


def tool_text(result: Any) -> str:
    """The tool output the SDK sends back, as text: a string (errors), one MCP content part, or a
    list of parts."""
    if isinstance(result, str):
        return result
    parts = result if isinstance(result, list) else [result]
    out = []
    for part in parts:
        if isinstance(part, dict) and part.get("type") == "text":
            out.append(str(part.get("text", "")))
        else:
            out.append(json.dumps(part, default=str, sort_keys=True))
    return "\n".join(out)


def parse_error(raw: str | None) -> str | None:
    """Why tool arguments are malformed, or None if they are a JSON object (or empty, which the
    SDK reads as {})."""
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except ValueError as exc:
        return f"not valid JSON ({exc})"
    return None if isinstance(value, dict) else "not a JSON object"


class TrialHooks(RunHooks):
    """The SDK's run hooks, mapped onto our spans and counts. Observation only: nothing here
    changes what the model or the tools see."""

    def __init__(self, ctx: TrialContext, adapter: OpenAIAgentsAdapter) -> None:
        self.ctx = ctx
        self.adapter = adapter
        self.model_calls = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.malformed: set[str] = set()
        self.unknown: set[str] = set()

    async def on_llm_start(self, context, agent, system_prompt, input_items) -> None:
        self.model_calls += 1
        # An unknown tool's span closes once its error output is in the next request.
        for item in input_items:
            if (
                isinstance(item, dict)
                and item.get("type") == "function_call_output"
                and item.get("call_id") in self.unknown
            ):
                self.unknown.discard(item["call_id"])
                self.ctx.tool_finished(
                    item["call_id"],
                    tool_text(item.get("output")),
                    is_error=True,
                    error_kind="unknown_tool",
                )

    async def on_llm_end(self, context, agent, response) -> None:
        if response.usage is not None:
            self.input_tokens += response.usage.input_tokens or 0
            self.output_tokens += response.usage.output_tokens or 0
        for item in response.output:
            if getattr(item, "type", None) != "function_call":
                continue
            if item.name not in self.adapter.tool_names:
                self.ctx.tool_started(item.call_id, item.name, item.arguments)
                self.ctx.error_event(
                    "unknown_tool",
                    f"model called {item.name!r}, which is not one of the task's tools; "
                    "the SDK returns an error to the model (tool_not_found_behavior)",
                )
                self.unknown.add(item.call_id)

    async def on_tool_start(self, context, agent, tool) -> None:
        call_id, raw = context.tool_call_id, context.tool_arguments
        self.ctx.tool_started(call_id, tool.name, raw)
        why = parse_error(raw)
        if why is not None:
            self.malformed.add(call_id)
            self.ctx.error_event(
                "malformed_tool_call",
                f"arguments for {tool.name} were {why}: {raw}. The SDK returns its fixed "
                "error text to the model.",
            )

    async def on_tool_end(self, context, agent, tool, result) -> None:
        call_id = context.tool_call_id
        text = tool_text(result)
        mcp_is_error = self.adapter.mcp_results.pop(call_id, None)
        if call_id in self.malformed:
            self.malformed.discard(call_id)
            self.ctx.tool_finished(call_id, text, is_error=True, error_kind="malformed_tool_call")
        elif mcp_is_error is None:
            # The MCP server never answered: the SDK caught an exception (a timeout, a broken
            # session) and gave the model its fixed error text instead.
            self.ctx.tool_finished(call_id, text, is_error=True, error_kind="tool_failure")
        else:
            kind = "tool_error" if mcp_is_error else None
            self.ctx.tool_finished(call_id, text, is_error=mcp_is_error, error_kind=kind)

    def close_unknown(self) -> None:
        for call_id in sorted(self.unknown):
            self.ctx.tool_finished(
                call_id, "(the run ended before the error reached the model)", True, "unknown_tool"
            )
        self.unknown.clear()


class OpenAIAgentsAdapter(Adapter):
    name = "openai-agents"
    capabilities_path = Path(__file__).with_name("capabilities.json")

    def version(self) -> str:
        sdk = importlib.metadata.version("openai-agents")
        return f"{sdk} (openai {openai.__version__}, mcp {importlib.metadata.version('mcp')})"

    # ---- the event loop the SDK runs on, kept for the whole trial so MCP stays connected
    def _start_loop(self) -> None:
        self.loop = asyncio.new_event_loop()
        thread = threading.Thread(target=self.loop.run_forever, name="agents-loop", daemon=True)
        thread.start()
        self._stop: asyncio.Event | None = None

    def _run(self, coro: Any, timeout: float | None = None) -> Any:
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout)

    async def _hold_servers(self, servers: list[MCPServerStdio], ready: Any) -> None:
        """Connect and later close the servers in one task (anyio's cancel scopes need that)."""
        self._stop = asyncio.Event()
        try:
            async with AsyncExitStack() as stack:
                for server in servers:
                    await stack.enter_async_context(server)
                ready.set_result(True)
                await self._stop.wait()
        except BaseException as exc:  # noqa: BLE001
            if not ready.done():
                ready.set_exception(exc)
            else:
                raise

    def _record_mcp_result(self, data: Any) -> None:
        """MCP custom-data extractor: called with every MCP result, so the tool span can carry
        the server's isError flag. Returns None, so nothing is added to the SDK's items."""
        call_id = getattr(data.run_context, "tool_call_id", None)
        if call_id is not None:
            self.mcp_results[call_id] = bool(data.is_error)

    async def _on_response(self, response: Any) -> None:
        """httpx response hook: the SDK does not surface finish_reason, so read it here to tell
        a reply cut at max_output_tokens (token_limit) from a finished one. Read-only."""
        if not response.request.url.path.endswith("/chat/completions"):
            return
        await response.aread()
        try:
            reason = response.json()["choices"][0]["finish_reason"]
        except ValueError, KeyError, IndexError, TypeError:
            reason = None
        self.finish_reasons.append(reason)

    def setup(self, ctx: TrialContext) -> None:
        settings = ctx.settings
        timeout_s = float(settings["timeout_s"])
        self.mcp_results: dict[str, bool] = {}
        self.finish_reasons: list[str | None] = []
        self.items: list[Any] | None = None
        self._start_loop()

        client = openai.AsyncOpenAI(
            base_url=ctx.base_url,
            api_key=ctx.model_api_key,
            max_retries=0,  # R10.11: retries happen once, in LiteLLM (D16)
            timeout=timeout_s,
            http_client=openai.DefaultAsyncHttpxClient(
                event_hooks={"response": [self._on_response]}
            ),
        )
        model = OpenAIChatCompletionsModel(model=ctx.model_name, openai_client=client)

        model_settings: dict[str, Any] = {"retry": ModelRetrySettings(max_retries=0)}
        if settings["temperature"] is not None:
            model_settings["temperature"] = settings["temperature"]
        if settings["max_output_tokens"] is not None:
            model_settings["max_tokens"] = settings["max_output_tokens"]
        if settings["parallel_tool_calls"] is not None:
            model_settings["parallel_tool_calls"] = settings["parallel_tool_calls"]

        servers = [
            MCPServerStdio(
                params={
                    "command": spec.command,
                    "args": spec.args,
                    "env": ctx.child_env(),
                    "cwd": str(ctx.paths.home),
                },
                name=spec.name,
                cache_tools_list=True,
                client_session_timeout_seconds=spec.tool_timeout_s,
                tool_filter=create_static_tool_filter(allowed_tool_names=spec.allowed_tools),
                max_retry_attempts=0,
                custom_data_extractor=self._record_mcp_result,
            )
            for spec in ctx.mcp_servers
        ]
        ready: concurrent.futures.Future = concurrent.futures.Future()
        asyncio.run_coroutine_threadsafe(self._hold_servers(servers, ready), self.loop)
        ready.result(timeout=min(60.0, timeout_s))

        self.tool_names: set[str] = set()
        for spec, server in zip(ctx.mcp_servers, servers, strict=True):
            listed = {t.name for t in self._run(server.list_tools(), timeout=30)}
            missing = set(spec.allowed_tools) - listed
            if missing:
                raise RuntimeError(f"{spec.name} does not offer {sorted(missing)}")
            if listed & self.tool_names:
                raise RuntimeError(f"tools {sorted(listed & self.tool_names)} offered twice")
            self.tool_names |= listed

        self.agent = Agent(
            name="assistant",
            instructions=ctx.system_prompt,
            model=model,
            model_settings=ModelSettings(**model_settings),
            mcp_servers=servers,
            mcp_config={"convert_schemas_to_strict": False},
        )
        self.run_config = RunConfig(
            tracing_disabled=True,
            trace_include_sensitive_data=False,
            workflow_name=ctx.spec["trial"]["id"],
            tool_not_found_behavior="return_error_to_model",  # D18
        )

        not_sent = "not sent; the provider's default applies"
        for name in ("top_p", "seed", "tool_choice"):
            ctx.applied.set(name, None, "harness_default", observed=not_sent)
        ctx.applied.set(
            "tool_concurrency",
            None,
            "harness_default",
            observed="the SDK runs every tool call of one model turn concurrently",
        )
        ctx.harness_extra.update(
            {
                "tool_names": sorted(self.tool_names),
                "api": "chat_completions",
                "conversation_carry": "result.to_input_list() plus the new user message",
            }
        )

    def run_turn(
        self, ctx: TrialContext, history: list[dict[str, str]], max_steps: int | None
    ) -> TurnResult:
        if self.items is None:
            self.items = [{"role": m["role"], "content": m["content"]} for m in history]
        else:
            self.items = [*self.items, {"role": "user", "content": history[-1]["content"]}]
        hooks = TrialHooks(ctx, self)
        first_response = len(self.finish_reasons)
        exc: BaseException | None = None
        result = None
        try:
            result = self._run(
                Runner.run(
                    self.agent,
                    self.items,
                    max_turns=max_steps,
                    hooks=hooks,
                    run_config=self.run_config,
                )
            )
        except BaseException as caught:  # noqa: BLE001
            exc = caught
        hooks.close_unknown()

        def turn(stop: str, reply: str | None, reason: str | None) -> TurnResult:
            return TurnResult(
                stop=stop,
                reply=reply,
                model_calls=hooks.model_calls,
                input_tokens=hooks.input_tokens,
                output_tokens=hooks.output_tokens,
                harness_stop_reason=reason,
                exception=exc,
            )

        if exc is None:
            assert result is not None
            self.items = result.to_input_list()
            reply = result.final_output
            reply = reply if isinstance(reply, str) else json.dumps(reply, default=str)
            reasons = self.finish_reasons[first_response:]
            last = reasons[-1] if reasons else None
            if last == "length":
                return turn("token_limit", reply or None, "length")
            return turn("answered", reply, last)
        name = type(exc).__name__
        if isinstance(exc, MaxTurnsExceeded):
            return turn("step_limit", None, f"{name}: max_turns {max_steps}")
        if isinstance(exc, ModelBehaviorError):
            if "finish_reason='length'" in str(exc):
                return turn("token_limit", None, "length with no output")
            return turn("agent_error", None, f"{name}: {exc}")
        if isinstance(exc, openai.APIError):
            return turn("harness_error", None, f"model call failed: {name}")
        if isinstance(exc, Exception):  # AgentsException and anything else the SDK raised
            return turn("harness_error", None, f"{name}: {exc}")
        raise exc

    def teardown(self, ctx: TrialContext) -> None:
        if self._stop is not None:
            self.loop.call_soon_threadsafe(self._stop.set)


def entry() -> None:
    main(OpenAIAgentsAdapter())


if __name__ == "__main__":
    entry()
