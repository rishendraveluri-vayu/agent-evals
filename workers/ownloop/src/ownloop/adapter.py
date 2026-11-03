"""The own plain loop: call the model, run any tool calls through MCP, repeat until it answers.

This is the reference harness. It adds nothing to the prompt and nothing to the tool schemas,
sends only the settings the spec gives, and never retries (R10.11): LiteLLM does that (D16).
What it does is what every other harness should be measured against.
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
from evals_adapter import Adapter, TrialContext, TurnResult, main
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


class McpHub:
    """MCP client sessions on a background event loop, so the loop above can stay synchronous.

    The sessions are opened and closed inside one long-lived task, because anyio's cancel
    scopes must be exited in the task that entered them. Tool calls run as their own tasks.
    """

    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, name="mcp-loop", daemon=True)
        self.thread.start()
        self.tools: dict[str, tuple[ClientSession, Any, float]] = {}
        self._stop: asyncio.Event | None = None

    def open(self, servers: list[Any], env: dict[str, str], cwd: str, timeout_s: float) -> None:
        ready: concurrent.futures.Future = concurrent.futures.Future()
        asyncio.run_coroutine_threadsafe(self._hold(servers, env, cwd, ready), self.loop)
        ready.result(timeout=timeout_s)

    async def _hold(self, servers, env, cwd, ready) -> None:
        self._stop = asyncio.Event()
        try:
            async with AsyncExitStack() as stack:
                for server in servers:
                    params = StdioServerParameters(
                        command=server.command, args=server.args, env=env, cwd=cwd
                    )
                    read, write = await stack.enter_async_context(stdio_client(params))
                    session = await stack.enter_async_context(ClientSession(read, write))
                    await session.initialize()
                    listed = await session.list_tools()
                    allowed = set(server.allowed_tools)
                    for tool in listed.tools:
                        if tool.name not in allowed:
                            continue
                        if tool.name in self.tools:
                            raise RuntimeError(f"tool {tool.name} is offered by two servers")
                        self.tools[tool.name] = (session, tool, server.tool_timeout_s)
                    missing = allowed - {t.name for t in listed.tools}
                    if missing:
                        raise RuntimeError(f"{server.name} does not offer {sorted(missing)}")
                ready.set_result(True)
                await self._stop.wait()
        except BaseException as exc:  # noqa: BLE001
            if not ready.done():
                ready.set_exception(exc)
            else:
                raise

    def call(self, name: str, arguments: dict[str, Any]) -> tuple[str, bool]:
        session, _, timeout_s = self.tools[name]
        future = asyncio.run_coroutine_threadsafe(
            session.call_tool(name, arguments, read_timeout_seconds=timeout_s), self.loop
        )
        result = future.result(timeout=timeout_s + 5)
        parts = [
            block.text if getattr(block, "type", None) == "text" else block.model_dump_json()
            for block in result.content
        ]
        return "\n".join(parts), bool(result.is_error)

    def close(self) -> None:
        if self._stop is not None:
            self.loop.call_soon_threadsafe(self._stop.set)


def openai_tool(tool: Any) -> dict[str, Any]:
    """The server's tool exactly as given: name, description and input schema, untouched.
    Read through the wire (JSON) form, so the schema is byte-for-byte what the server sent."""
    wire = tool.model_dump(mode="json", by_alias=True, exclude_none=True)
    function: dict[str, Any] = {"name": wire["name"], "parameters": wire["inputSchema"]}
    if wire.get("description"):
        function["description"] = wire["description"]
    return {"type": "function", "function": function}


class OwnLoop(Adapter):
    name = "ownloop"
    capabilities_path = Path(__file__).with_name("capabilities.json")

    def version(self) -> str:
        own = importlib.metadata.version("ownloop")
        return f"{own} (openai {openai.__version__}, mcp {importlib.metadata.version('mcp')})"

    def setup(self, ctx: TrialContext) -> None:
        settings = ctx.settings
        timeout_s = float(settings["timeout_s"])
        self.client = openai.OpenAI(
            base_url=ctx.base_url,
            api_key=ctx.model_api_key,
            max_retries=0,  # R10.11: retries happen once, in LiteLLM (D16)
            timeout=timeout_s,
        )
        self.hub = McpHub()
        self.hub.open(
            ctx.mcp_servers, ctx.child_env(), str(ctx.paths.home), timeout_s=min(60.0, timeout_s)
        )
        self.tools = [openai_tool(tool) for _, tool, _ in self.hub.tools.values()]
        self.request: dict[str, Any] = {"model": ctx.model_name, "stream": False}
        if self.tools:
            self.request["tools"] = self.tools
        if settings["temperature"] is not None:
            self.request["temperature"] = settings["temperature"]
        if settings["max_output_tokens"] is not None:
            self.request["max_tokens"] = settings["max_output_tokens"]
        if settings["parallel_tool_calls"] is not None and self.tools:
            self.request["parallel_tool_calls"] = settings["parallel_tool_calls"]
        not_sent = "not sent; the provider's default applies"
        for name in ("top_p", "seed", "tool_choice"):
            ctx.applied.set(name, None, "harness_default", observed=not_sent)
        ctx.harness_extra["tool_names"] = [t["function"]["name"] for t in self.tools]
        self.messages: list[dict[str, Any]] = []

    def run_turn(
        self, ctx: TrialContext, history: list[dict[str, str]], max_steps: int | None
    ) -> TurnResult:
        if not self.messages:
            self.messages = [{"role": "system", "content": ctx.system_prompt}] + [
                {"role": m["role"], "content": m["content"]} for m in history
            ]
        else:
            self.messages.append({"role": "user", "content": history[-1]["content"]})
        calls, tokens_in, tokens_out = 0, 0, 0
        while max_steps is None or calls < max_steps:
            calls += 1
            try:
                response = self.client.chat.completions.create(
                    messages=self.messages, **self.request
                )
            except openai.APIError as exc:
                return TurnResult(
                    stop="harness_error",
                    reply=None,
                    model_calls=calls,
                    exception=exc,
                    input_tokens=tokens_in,
                    output_tokens=tokens_out,
                    harness_stop_reason=f"model call failed: {type(exc).__name__}",
                )
            if response.usage is not None:
                tokens_in += response.usage.prompt_tokens or 0
                tokens_out += response.usage.completion_tokens or 0
            choice = response.choices[0]
            message = choice.message
            if choice.finish_reason == "length":
                return TurnResult(
                    stop="token_limit",
                    reply=message.content or None,
                    model_calls=calls,
                    input_tokens=tokens_in,
                    output_tokens=tokens_out,
                    harness_stop_reason="length",
                )
            if not message.tool_calls:
                self.messages.append({"role": "assistant", "content": message.content or ""})
                return TurnResult(
                    stop="answered",
                    reply=message.content or "",
                    model_calls=calls,
                    input_tokens=tokens_in,
                    output_tokens=tokens_out,
                    harness_stop_reason=choice.finish_reason,
                )
            self.messages.append(
                {
                    "role": "assistant",
                    "content": message.content,
                    "tool_calls": [tc.model_dump(exclude_none=True) for tc in message.tool_calls],
                }
            )
            for tc in message.tool_calls:
                self.messages.append(
                    {"role": "tool", "tool_call_id": tc.id, "content": self._run_tool(ctx, tc)}
                )
        return TurnResult(
            stop="step_limit",
            reply=None,
            model_calls=calls,
            input_tokens=tokens_in,
            output_tokens=tokens_out,
            harness_stop_reason=f"max_steps {max_steps} reached",
        )

    def _run_tool(self, ctx: TrialContext, tc: Any) -> str:
        """Run one tool call. Every error goes back to the model as the tool's result (D18)."""
        name, raw = tc.function.name, tc.function.arguments or ""
        ctx.tool_started(tc.id, name, raw)
        if name not in self.hub.tools:
            text = f"Error: unknown tool {name!r}. Available tools: {sorted(self.hub.tools)}"
            ctx.error_event("unknown_tool", text)
            ctx.tool_finished(tc.id, text, is_error=True, error_kind="unknown_tool")
            return text
        try:
            arguments = json.loads(raw) if raw.strip() else {}
            if not isinstance(arguments, dict):
                raise ValueError("arguments must be a JSON object")
        except ValueError as exc:
            text = f"Error: the tool arguments were not valid JSON ({exc}). Arguments: {raw}"
            ctx.error_event("malformed_tool_call", text)
            ctx.tool_finished(tc.id, text, is_error=True, error_kind="malformed_tool_call")
            return text
        try:
            text, is_error = self.hub.call(name, arguments)
        except Exception as exc:  # noqa: BLE001
            text = f"Error: the tool call failed: {type(exc).__name__}: {exc}"
            ctx.tool_finished(tc.id, text, is_error=True, error_kind="tool_failure")
            return text
        kind = "tool_error" if is_error else None
        ctx.tool_finished(tc.id, text, is_error=is_error, error_kind=kind)
        return text

    def teardown(self, ctx: TrialContext) -> None:
        self.hub.close()


def entry() -> None:
    main(OwnLoop())


if __name__ == "__main__":
    entry()
