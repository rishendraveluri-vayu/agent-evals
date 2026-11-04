# ruff: noqa: E402 - the environment is cleaned before LangChain is imported
"""The LangGraph harness on the shared adapter library (contract v2, docs/adapter-contract.md).

LangChain's `create_agent`, which compiles a LangGraph graph (a model node, a tools node and
middleware hooks), with the finance tools from langchain-mcp-adapters and the model through
ChatOpenAI. It is used as it comes. Each switch below is there because a rule needs it (R10),
and the README lists them with what LangGraph does on its own:

- the model only through the spec's base_url and key, with retries off (R10.3, R10.11), on Chat
  Completions with streaming off (so usage arrives), and only the settings the spec sets;
- the step limit in LangChain's own ModelCallLimitMiddleware, in error mode (D17);
- tool exceptions back to the model through LangChain's own ToolErrorMiddleware (D18);
- the conversation in LangGraph's own session state: a checkpointer and one thread per trial.

Two adapter middlewares sit in the graph. TrialObserver only reports (spans, counts, usage) and
changes nothing; RequestSettings puts parallel_tool_calls where LangChain binds tool settings.
"""

from __future__ import annotations

import os

# LangSmith traces only when a *_TRACING variable is "true", and the others reroute or reshape
# model calls (docs/research/harnesses/langgraph.md sections 3 and 7). The runner's environment
# has none of them; this makes sure, before LangChain reads them at import.
for _name in (
    "LANGSMITH_API_KEY",
    "LANGCHAIN_API_KEY",
    "LANGSMITH_ENDPOINT",
    "LANGCHAIN_ENDPOINT",
    "LANGSMITH_GATEWAY",
    "LC_OUTPUT_VERSION",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_API_BASE",
    "OPENAI_ORG_ID",
    "OPENAI_ORGANIZATION",
    "OPENAI_PROJECT",
    "OPENAI_PROXY",
):
    os.environ.pop(_name, None)
for _name in ("LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2", "LANGCHAIN_TRACING"):
    os.environ[_name] = "false"

import asyncio
import concurrent.futures
import importlib.metadata
import json
import threading
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path
from typing import Any

import openai
from evals_adapter import Adapter, TrialContext, TurnResult, main
from langchain.agents import create_agent
from langchain.agents.middleware import (
    AgentMiddleware,
    ModelCallLimitMiddleware,
    ToolErrorMiddleware,
)
from langchain.agents.middleware.model_call_limit import ModelCallLimitExceededError
from langchain_core.messages import AIMessage, ToolMessage, messages_to_dict
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.tools import load_mcp_tools
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import InMemorySaver

# Set to True once setup and run_turn work; the gate tests skip until then.
IMPLEMENTED = True

PACKAGES = (
    "langgraph",
    "langchain",
    "langchain-core",
    "langchain-openai",
    "langchain-mcp-adapters",
    "mcp",
)
NOT_SENT_BACK = "never sent to the model: the run ended before another model call"


def text_of(content: Any) -> str:
    """Message content as text: LangChain sends tool results as a list of text parts."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part if isinstance(part, str) else str(part.get("text", ""))
            for part in content
            if isinstance(part, str | dict)
        )
    return "" if content is None else str(content)


@dataclass
class Turn:
    """What the observer saw during one agent turn (one `ainvoke`)."""

    calls: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    usage_known: bool = True
    malformed: dict[str, str] = field(default_factory=dict)  # open span id -> tool name
    crashed: set[str] = field(default_factory=set)  # tool call ids ToolErrorMiddleware caught

    def result(self, stop: str, reply: str | None, **kw: Any) -> TurnResult:
        known = self.usage_known
        return TurnResult(
            stop=stop,
            reply=reply,
            model_calls=self.calls,
            input_tokens=self.tokens_in if known else None,
            output_tokens=self.tokens_out if known else None,
            **kw,
        )


class TrialObserver(AgentMiddleware):
    """Reports every model call and every tool call LangGraph runs, and changes nothing."""

    def __init__(self, adapter: LangGraphAdapter) -> None:
        super().__init__()
        self.adapter = adapter

    async def awrap_model_call(self, request, handler):
        turn, ctx = self.adapter.turn, self.adapter.ctx
        # A malformed call from the previous response: LangChain answers it at the next model
        # call with its own error ToolMessage (factory._patch_invalid_tool_calls). Record that.
        for message in request.messages:
            if isinstance(message, ToolMessage) and message.tool_call_id in turn.malformed:
                turn.malformed.pop(message.tool_call_id)
                ctx.tool_finished(
                    message.tool_call_id,
                    text_of(message.content),
                    is_error=True,
                    error_kind="malformed_tool_call",
                )
        turn.calls += 1
        response = await handler(request)
        reply = next((m for m in reversed(response.result) if isinstance(m, AIMessage)), None)
        if reply is not None:
            usage = reply.usage_metadata
            if usage is None:
                turn.usage_known = False
            else:
                turn.tokens_in += usage.get("input_tokens", 0)
                turn.tokens_out += usage.get("output_tokens", 0)
            for bad in reply.invalid_tool_calls:
                call_id = bad.get("id") or f"invalid-{turn.calls}-{len(turn.malformed)}"
                name = bad.get("name") or "unknown"
                ctx.tool_started(call_id, name, bad.get("args") or "")
                ctx.error_event(
                    "malformed_tool_call", f"{name}: {bad.get('error') or 'invalid arguments'}"
                )
                turn.malformed[call_id] = name
        return response

    async def awrap_tool_call(self, request, handler):
        turn, ctx = self.adapter.turn, self.adapter.ctx
        call = request.tool_call
        call_id = call.get("id")
        ctx.tool_started(call_id, call["name"], call.get("args", {}))
        try:
            message = await handler(request)
        except Exception as exc:
            # ToolErrorMiddleware hands every exception back to the model, so this is a crash
            # it could not catch. LangGraph ends the run; the turn maps it to harness_error.
            ctx.tool_finished(
                call_id, f"{type(exc).__name__}: {exc}", is_error=True, error_kind="tool_crash"
            )
            raise
        if not isinstance(message, ToolMessage):
            ctx.tool_finished(call_id, repr(message))
            return message
        text = text_of(message.content)
        if message.status != "error":
            ctx.tool_finished(call_id, text)
        elif request.tool is None:
            ctx.error_event("unknown_tool", text)
            ctx.tool_finished(call_id, text, is_error=True, error_kind="unknown_tool")
        elif call_id in turn.crashed:
            ctx.tool_finished(call_id, text, is_error=True, error_kind="tool_failure")
        else:
            ctx.tool_finished(call_id, text, is_error=True, error_kind="tool_error")
        return message


class RequestSettings(AgentMiddleware):
    """parallel_tool_calls where create_agent binds tool settings: ModelRequest.model_settings,
    which reaches ChatOpenAI.bind_tools(parallel_tool_calls=...)."""

    def __init__(self, model_settings: dict[str, Any]) -> None:
        super().__init__()
        self.model_settings = model_settings

    async def awrap_model_call(self, request, handler):
        settings = {**request.model_settings, **self.model_settings}
        return await handler(request.override(model_settings=settings))


class EventLoop:
    """One asyncio loop on a background thread. LangChain's MCP tools are coroutine-only, so
    the agent runs async, while the library's run_turn is synchronous and waits here."""

    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(
            target=self.loop.run_forever, name="langgraph-loop", daemon=True
        )
        self.thread.start()

    def run(self, coro: Any, timeout: float | None = None) -> Any:
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout)


class LangGraphAdapter(Adapter):
    name = "langgraph"
    capabilities_path = Path(__file__).with_name("capabilities.json")

    def version(self) -> str:
        v = {p: importlib.metadata.version(p) for p in PACKAGES}
        rest = ", ".join(f"{p} {v[p]}" for p in PACKAGES[1:])
        return f"langgraph {v['langgraph']} ({rest})"

    # ---- setup: apply_settings

    def setup(self, ctx: TrialContext) -> None:
        settings = ctx.settings
        timeout_s = float(settings["timeout_s"])
        self.ctx = ctx
        self.turn = Turn()
        self.turns_run = 0
        self.events = EventLoop()
        self._stop: asyncio.Event | None = None
        ready: concurrent.futures.Future = concurrent.futures.Future()
        asyncio.run_coroutine_threadsafe(self._hold_mcp(ctx, ready), self.events.loop)
        self.tools = ready.result(timeout=min(60.0, timeout_s))

        model_args: dict[str, Any] = {
            "model": ctx.model_name,
            "base_url": ctx.base_url,  # beats the OPENAI_* variables and the LangSmith gateway
            "api_key": ctx.model_api_key,
            "max_retries": 0,  # R10.11: retries happen once, in LiteLLM (D16); SDK default is 2
            "timeout": timeout_s,  # per HTTP request; the SDK default is 600 s
            "use_responses_api": False,  # never switch to the Responses API by model name
            "disable_streaming": True,  # streamed calls come back without usage
            "cache": False,
        }
        if settings["temperature"] is not None:
            model_args["temperature"] = settings["temperature"]
        if settings["max_output_tokens"] is not None:
            model_args["max_tokens"] = settings["max_output_tokens"]  # sent max_completion_tokens
        model = ChatOpenAI(**model_args)

        # First is outermost: the observer sees every call, including errors from the others.
        middleware: list[AgentMiddleware] = [TrialObserver(self)]
        if settings["parallel_tool_calls"] is not None and self.tools:
            middleware.append(
                RequestSettings({"parallel_tool_calls": settings["parallel_tool_calls"]})
            )
        if settings["max_steps"] is not None:
            # D17: one step is one model call, across the whole trial (the thread), conversation
            # included. Error mode: the default "end" writes a fake final answer.
            middleware.append(
                ModelCallLimitMiddleware(thread_limit=settings["max_steps"], exit_behavior="error")
            )
        middleware.append(ToolErrorMiddleware(aon_error=self._tool_exception))
        self.agent = create_agent(
            model,
            tools=self.tools,
            system_prompt=ctx.system_prompt,
            middleware=middleware,
            checkpointer=InMemorySaver(),  # this trial's conversation only, in memory
        )
        self.config = {"configurable": {"thread_id": ctx.spec["trial"]["id"]}}

        not_sent = "not sent; the provider's default applies"
        for name in ("top_p", "seed", "tool_choice"):
            ctx.applied.set(name, None, "harness_default", observed=not_sent)
        recursion = (getattr(self.agent, "config", None) or {}).get("recursion_limit")
        ctx.applied.set(
            "recursion_limit",
            recursion,
            "harness_default",
            observed="create_agent's default; counts graph supersteps, not model calls",
        )
        ctx.harness_extra["tool_names"] = [t.name for t in self.tools]

    async def _hold_mcp(self, ctx: TrialContext, ready: concurrent.futures.Future) -> None:
        """Open one MCP session per server and keep it for the trial. The sessions are opened
        and closed in this one task, because anyio's cancel scopes must be exited in the task
        that entered them. (MultiServerMCPClient.get_tools would open a session per call.)"""
        self._stop = asyncio.Event()
        servers = ctx.mcp_servers
        connections = {
            s.name: {
                "transport": "stdio",
                "command": s.command,
                "args": s.args,
                "env": ctx.child_env(),  # leaves the model key out
                "cwd": str(ctx.paths.home),
                # The MCP tool timeout: the session's read timeout covers every tool call.
                "session_kwargs": {"read_timeout_seconds": timedelta(seconds=s.tool_timeout_s)},
            }
            for s in servers
        }
        client = MultiServerMCPClient(connections)
        try:
            async with AsyncExitStack() as stack:
                tools: list[Any] = []
                for server in servers:
                    session = await stack.enter_async_context(client.session(server.name))
                    loaded = await load_mcp_tools(session, server_name=server.name)
                    allowed = set(server.allowed_tools)
                    for tool in loaded:
                        if tool.name not in allowed:
                            continue
                        if any(t.name == tool.name for t in tools):
                            raise RuntimeError(f"tool {tool.name} is offered by two servers")
                        tools.append(tool)
                    missing = allowed - {t.name for t in loaded}
                    if missing:
                        raise RuntimeError(f"{server.name} does not offer {sorted(missing)}")
                ready.set_result(tools)
                await self._stop.wait()
        except BaseException as exc:  # noqa: BLE001
            if not ready.done():
                ready.set_exception(exc)
            else:
                raise

    async def _tool_exception(self, exc: Exception, request: Any) -> str:
        """D18: a tool that raised (an MCP timeout or transport failure) goes back to the model
        as an error result, in the own loop's words, instead of ending the run."""
        call_id = request.tool_call.get("id")
        if call_id:
            self.turn.crashed.add(call_id)
        return f"Error: the tool call failed: {type(exc).__name__}: {exc}"

    # ---- run_turn

    def run_turn(
        self, ctx: TrialContext, history: list[dict[str, str]], max_steps: int | None
    ) -> TurnResult:
        # The checkpointer holds earlier turns; send only what is new. max_steps is enforced
        # for the whole trial by ModelCallLimitMiddleware's thread limit.
        new = history if self.turns_run == 0 else history[-1:]
        self.turns_run += 1
        messages = [{"role": m["role"], "content": m["content"]} for m in new]
        return self.events.run(self._turn(messages))

    async def _turn(self, messages: list[dict[str, str]]) -> TurnResult:
        turn = self.turn = Turn()
        try:
            out = await self.agent.ainvoke({"messages": messages}, self.config)
        except ModelCallLimitExceededError as exc:
            return turn.result("step_limit", None, harness_stop_reason=str(exc))
        except openai.APIError as exc:
            reason = f"model call failed: {type(exc).__name__}"
            return turn.result("harness_error", None, exception=exc, harness_stop_reason=reason)
        except Exception as exc:  # noqa: BLE001
            reason = f"graph raised {type(exc).__name__}"
            return turn.result("harness_error", None, exception=exc, harness_stop_reason=reason)
        finally:
            for call_id in list(turn.malformed):
                turn.malformed.pop(call_id)
                self.ctx.tool_finished(
                    call_id, NOT_SENT_BACK, is_error=True, error_kind="malformed_tool_call"
                )
        last = out["messages"][-1] if out.get("messages") else None
        if not isinstance(last, AIMessage):
            reason = f"the run ended on {type(last).__name__}, not a model reply"
            return turn.result("harness_error", None, harness_stop_reason=reason)
        finish = last.response_metadata.get("finish_reason")
        text = text_of(last.content)
        if finish == "length":
            return turn.result("token_limit", text or None, harness_stop_reason="length")
        if last.invalid_tool_calls and not last.tool_calls:
            # D18: LangGraph's router ends the run when no valid tool call is left, so the
            # malformed call never goes back to the model and the run looks answered with an
            # empty reply. Labelled here; LangGraph's own signals are in harness_stop_reason.
            reason = (
                f"malformed_tool_call ended the run: finish_reason {finish}, "
                f"{len(last.invalid_tool_calls)} invalid tool call(s), no valid ones"
            )
            return turn.result("agent_error", None, harness_stop_reason=reason)
        return turn.result("answered", text, harness_stop_reason=finish)

    # ---- after the run

    def collect(self, ctx: TrialContext) -> None:
        """LangGraph's own record of the conversation: every message with its usage, finish
        reason and invalid tool calls, for relabelling without re-running."""
        state = self.events.run(self.agent.aget_state(self.config), timeout=10)
        messages = messages_to_dict(state.values.get("messages", []))
        ctx.write_artifact(
            "langgraph-messages.json",
            json.dumps(messages, indent=1, ensure_ascii=False, default=str),
        )

    def teardown(self, ctx: TrialContext) -> None:
        if self._stop is not None:
            self.events.loop.call_soon_threadsafe(self._stop.set)


def entry() -> None:
    main(LangGraphAdapter())


if __name__ == "__main__":
    entry()
