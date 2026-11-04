"""Google ADK on the shared adapter library (contract v2, docs/adapter-contract.md).

One `LlmAgent` per trial, run by a `Runner` with a fresh in-memory session and no memory,
artifact or credential service. The model is a `LiteLlm` object routed to the trial's LiteLLM
proxy URL with the trial key, and the finance tools come from `McpToolset` over stdio. ADK's
own session carries earlier turns, so each turn sends only the new user message.

What ADK adds to the request is kept, never stripped (D20): its identity line and the fencing
preamble in the system prompt, the untrusted markers around every MCP tool and parameter
description, and tool results sent as the whole MCP result in JSON. Everything this adapter sets
is there to keep a hidden behaviour out of the comparison; see README.md, Findings.
"""

from __future__ import annotations

import os
import re
import sys

# Before anything imports litellm (ADK imports it lazily): read LiteLLM's price map from the
# package instead of fetching it from GitHub, keep LiteLLM in production mode (no .env autoload),
# and keep OpenTelemetry's SDK off. Then drop anything that could route ADK to a provider
# directly or flip its behaviour from outside the spec: provider keys, Google project settings,
# ADK feature flags, LiteLLM switches, OpenTelemetry exporters.
_SCRUB = re.compile(r"^(GOOGLE_|GEMINI_|VERTEX|ADK_|OTEL_|LITELLM_|OPENAI_|ANTHROPIC_|AZURE_|AWS_)")
_SCRUBBED = sorted(k for k in os.environ if _SCRUB.match(k))
for _name in _SCRUBBED:
    del os.environ[_name]
os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
os.environ["LITELLM_MODE"] = "PRODUCTION"
os.environ["OTEL_SDK_DISABLED"] = "true"

import asyncio  # noqa: E402
import importlib.metadata  # noqa: E402
import json  # noqa: E402
import threading  # noqa: E402
from pathlib import Path  # noqa: E402
from typing import Any  # noqa: E402

import litellm  # noqa: E402
from evals_adapter import Adapter, TrialContext, TurnResult, main  # noqa: E402
from google.adk.agents import LlmAgent, RunConfig  # noqa: E402
from google.adk.agents.invocation_context import LlmCallsLimitExceededError  # noqa: E402
from google.adk.apps import App  # noqa: E402
from google.adk.events import Event  # noqa: E402
from google.adk.models.lite_llm import LiteLlm  # noqa: E402
from google.adk.plugins import ReflectAndRetryModelPlugin  # noqa: E402
from google.adk.plugins.base_plugin import BasePlugin  # noqa: E402
from google.adk.runners import Runner  # noqa: E402
from google.adk.sessions import InMemorySessionService  # noqa: E402
from google.adk.tools.mcp_tool import McpToolset, StdioConnectionParams  # noqa: E402
from google.adk.version import __version__ as ADK_VERSION  # noqa: E402
from google.genai import types  # noqa: E402
from mcp import StdioServerParameters  # noqa: E402

# LiteLLM prints a "Give Feedback / Get Help" banner to stdout on every API error otherwise.
litellm.suppress_debug_info = True

APP_NAME = "evals"
USER_ID = "trial"
# ADK writes this into the system prompt ('You are an agent. Your internal name is "assistant".').
# A neutral, fixed name, the same in every trial.
AGENT_NAME = "assistant"
# The tool ADK's ReflectAndRetryModelPlugin answers a malformed call with (D18).
REFLECT_TOOL = "adk_handle_model_error"
MALFORMED = types.FinishReason.MALFORMED_FUNCTION_CALL


def log(message: str) -> None:
    print(f"[adk-adapter] {message}", file=sys.stderr, flush=True)


class _Loop:
    """One event loop on a background thread for the whole trial: ADK is async, the library's
    turn loop is not, and the MCP session must outlive each turn."""

    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, name="adk-loop", daemon=True)
        self.thread.start()

    def run(self, coro: Any, timeout: float | None = None) -> Any:
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout)


class _Observer(BasePlugin):
    """Reports what ADK does to the trace. It never changes a request, a response or a tool
    result: every callback returns None. It is the first plugin, so it sees each model response
    before the reflect-and-retry plugin replaces a malformed one."""

    def __init__(self, ctx: TrialContext, tool_names: set[str]) -> None:
        super().__init__(name="evals_observer")
        self.ctx = ctx
        self.tool_names = tool_names
        self.attempts = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.error_kinds: dict[str, str] = {}
        self.open_calls: set[str] = set()

    async def before_model_callback(self, *, callback_context, llm_request) -> None:
        # ADK checks max_llm_calls after this callback, so the attempt that trips the limit is
        # counted here but never sent; run_turn takes it off again.
        self.attempts += 1

    async def after_model_callback(self, *, callback_context, llm_response) -> None:
        if llm_response.partial:
            return
        usage = llm_response.usage_metadata
        if usage is not None:
            self.input_tokens += usage.prompt_token_count or 0
            self.output_tokens += usage.candidates_token_count or 0
        if llm_response.error_code == MALFORMED:
            self.ctx.error_event("malformed_tool_call", llm_response.error_message or "")

    async def before_tool_callback(self, *, tool, tool_args, tool_context) -> None:
        call_id = tool_context.function_call_id
        self.ctx.tool_started(call_id, tool.name, tool_args)
        self.open_calls.add(call_id)
        if tool.name == REFLECT_TOOL:
            self.error_kinds[call_id] = "malformed_tool_call"

    async def on_tool_error_callback(self, *, tool, tool_args, tool_context, error) -> None:
        call_id = tool_context.function_call_id
        if tool.name not in self.tool_names and isinstance(error, ValueError):
            self.error_kinds[call_id] = "unknown_tool"
            self.ctx.error_event("unknown_tool", str(error))
        else:
            self.error_kinds[call_id] = "tool_failure"


def _text(content: types.Content | None) -> str:
    if content is None or not content.parts:
        return ""
    return "".join(p.text for p in content.parts if p.text and not p.thought)


def _tool_error_kind(response: Any) -> str | None:
    """MCP's own isError, or ADK's {"error": ...} for a failed MCP call or an unknown tool."""
    if isinstance(response, dict):
        if response.get("isError") is True:
            return "tool_error"
        if "error" in response:
            return "tool_failure"
    return None


class AdkAdapter(Adapter):
    name = "adk"
    capabilities_path = Path(__file__).with_name("capabilities.json")

    def version(self) -> str:
        return f"google-adk {ADK_VERSION} (litellm {importlib.metadata.version('litellm')})"

    def setup(self, ctx: TrialContext) -> None:
        if _SCRUBBED:
            log(f"removed from the environment: {', '.join(_SCRUBBED)}")
        settings = ctx.settings
        timeout_s = float(settings["timeout_s"])
        self.loop = _Loop()

        self.toolsets: list[McpToolset] = []
        for server in ctx.mcp_servers:
            params = StdioServerParameters(
                command=server.command,
                args=server.args,
                env=ctx.child_env(),
                cwd=str(ctx.paths.home),
            )
            self.toolsets.append(
                McpToolset(
                    # For stdio, ADK uses this timeout to connect and as each call's read
                    # timeout. Its default is 5 s (D14 transport).
                    connection_params=StdioConnectionParams(
                        server_params=params, timeout=server.tool_timeout_s
                    ),
                    tool_filter=list(server.allowed_tools),
                )
            )
        self.tool_names = self.loop.run(self._check_tools(ctx), timeout=min(60.0, timeout_s))

        model_args: dict[str, Any] = {
            "api_base": ctx.base_url,
            "api_key": ctx.model_api_key,
            # R10.11: no retries below the proxy. num_retries is LiteLLM's own retry loop and
            # max_retries the OpenAI client's, which LiteLLM otherwise sets to 2 (D16).
            "num_retries": 0,
            "max_retries": 0,
            "timeout": timeout_s,
        }
        if settings["parallel_tool_calls"] is not None and self.tool_names:
            model_args["parallel_tool_calls"] = settings["parallel_tool_calls"]
        # Always a model object, never a model string: a string such as "gemini-..." resolves to
        # ADK's native Gemini class, which calls Google directly.
        model = LiteLlm(model=f"openai/{ctx.model_name}", **model_args)

        config: dict[str, Any] = {}
        if settings["temperature"] is not None:
            config["temperature"] = settings["temperature"]
        if settings["max_output_tokens"] is not None:
            config["max_output_tokens"] = settings["max_output_tokens"]
        system_prompt = ctx.system_prompt
        agent = LlmAgent(
            name=AGENT_NAME,
            model=model,
            # A callable, so ADK sends the prompt as written. A plain string is a template:
            # ADK fills {name} from session state and fails on a name it does not know.
            instruction=lambda _ctx: system_prompt,
            tools=list(self.toolsets),
            generate_content_config=types.GenerateContentConfig(**config) if config else None,
        )
        self.observer = _Observer(ctx, set(self.tool_names))
        # D18: ADK's own way to send a malformed tool call back to the model, as a call to its
        # adk_handle_model_error tool with reflection guidance. Defaults otherwise, except that
        # going past its limit ends the turn as an error event rather than an exception.
        reflect = ReflectAndRetryModelPlugin(throw_exception_if_retry_exceeded=False)
        app = App(name=APP_NAME, root_agent=agent, plugins=[self.observer, reflect])
        self.sessions = InMemorySessionService()
        self.runner = Runner(app=app, session_service=self.sessions)
        self.session_id = self.loop.run(self._new_session(), timeout=30)
        self.started = False

        not_sent = "not sent; the provider's default applies"
        for name in ("top_p", "seed", "tool_choice"):
            ctx.applied.set(name, None, "harness_default", observed=not_sent)
        ctx.harness_extra.update(
            {
                "tool_names": list(self.tool_names),
                "model_route": f"LiteLlm(model='openai/{ctx.model_name}'), litellm library",
                "agent_name": AGENT_NAME,
                "malformed_tool_call_retries": reflect.max_retries,
                "scrubbed_env": _SCRUBBED,
            }
        )

    async def _check_tools(self, ctx: TrialContext) -> list[str]:
        names: list[str] = []
        for server, toolset in zip(ctx.mcp_servers, self.toolsets, strict=True):
            listed = [t.name for t in await toolset.get_tools()]
            missing = set(server.allowed_tools) - set(listed)
            if missing:
                raise RuntimeError(f"{server.name} does not offer {sorted(missing)}")
            dup = set(listed) & set(names)
            if dup:
                raise RuntimeError(f"tools {sorted(dup)} are offered by two servers")
            names.extend(listed)
        return names

    async def _new_session(self) -> str:
        session = await self.sessions.create_session(app_name=APP_NAME, user_id=USER_ID)
        return session.id

    async def _seed(self, earlier: list[dict[str, str]]) -> None:
        """A task that opens with several messages: put all but the last into the session."""
        session = await self.sessions.get_session(
            app_name=APP_NAME, user_id=USER_ID, session_id=self.session_id
        )
        for message in earlier:
            if message["role"] not in ("user", "assistant"):
                raise ValueError(f"cannot seed a {message['role']!r} message into ADK")
            role, author = ("user", "user") if message["role"] == "user" else ("model", AGENT_NAME)
            content = types.Content(role=role, parts=[types.Part(text=message["content"])])
            await self.sessions.append_event(session, Event(author=author, content=content))

    def run_turn(
        self, ctx: TrialContext, history: list[dict[str, str]], max_steps: int | None
    ) -> TurnResult:
        if not self.started:
            self.started = True
            if len(history) > 1:
                self.loop.run(self._seed(history[:-1]), timeout=30)
        obs = self.observer
        before = (obs.attempts, obs.input_tokens, obs.output_tokens)
        stop, reply, reason, exc = self.loop.run(self._turn(ctx, history[-1]["content"], max_steps))
        calls = obs.attempts - before[0] - (1 if stop == "step_limit" else 0)
        return TurnResult(
            stop=stop,
            reply=reply,
            model_calls=calls,
            input_tokens=obs.input_tokens - before[1],
            output_tokens=obs.output_tokens - before[2],
            harness_stop_reason=reason,
            exception=exc,
        )

    async def _turn(
        self, ctx: TrialContext, text: str, max_steps: int | None
    ) -> tuple[str, str | None, str | None, BaseException | None]:
        # max_llm_calls counts model calls in this invocation, so it gets what is left of the
        # trial's budget (D17). Without one, ADK's own default (500) applies.
        run_config = RunConfig() if max_steps is None else RunConfig(max_llm_calls=max_steps)
        message = types.Content(role="user", parts=[types.Part(text=text)])
        reply: str | None = None
        last: Event | None = None
        try:
            async for event in self.runner.run_async(
                user_id=USER_ID,
                session_id=self.session_id,
                new_message=message,
                run_config=run_config,
            ):
                if event.partial:
                    continue
                if event.get_function_responses():  # tool results, not a model response
                    self._finish_tools(ctx, event)
                    continue
                if event.author == AGENT_NAME and event.content is not None:
                    last = event
                    if not event.get_function_calls():
                        reply = _text(event.content)
        except LlmCallsLimitExceededError as exc:
            self._close_open_tools(ctx, "step limit")
            return "step_limit", None, f"max_llm_calls {max_steps} reached: {exc}", None
        except Exception as exc:  # noqa: BLE001 - litellm.exceptions.* and anything else
            self._close_open_tools(ctx, f"{type(exc).__name__}")
            return "harness_error", None, f"model call failed: {type(exc).__name__}", exc
        self._close_open_tools(ctx, "turn ended")
        if last is None:
            return "harness_error", None, "ADK produced no model event", None
        finish = last.finish_reason.name if last.finish_reason else None
        if last.error_code:
            code = str(getattr(last.error_code, "name", last.error_code))
            detail = f"{code}: {last.error_message}" if last.error_message else code
            if last.error_code == types.FinishReason.MAX_TOKENS:
                return "token_limit", reply or None, detail, None
            return "agent_error", None, detail, None
        if last.get_function_calls():
            return "agent_error", None, "turn ended on a function call", None
        return "answered", reply or "", finish, None

    def _finish_tools(self, ctx: TrialContext, event: Event) -> None:
        """End each tool span from the function response ADK sends back to the model, so the
        span holds exactly what the model read (serialised as ADK serialises it)."""
        for response in event.get_function_responses():
            body = response.response
            text = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)
            kind = self.observer.error_kinds.pop(response.id, None) or _tool_error_kind(body)
            self.observer.open_calls.discard(response.id)
            ctx.tool_finished(response.id, text, is_error=kind is not None, error_kind=kind)

    def _close_open_tools(self, ctx: TrialContext, why: str) -> None:
        """A tool the turn left without a result (the run stopped mid-call)."""
        self.observer.error_kinds.clear()
        for call_id in sorted(self.observer.open_calls):
            ctx.tool_finished(call_id, f"no result: {why}", is_error=True, error_kind="interrupted")
        self.observer.open_calls.clear()

    def collect(self, ctx: TrialContext) -> None:
        """ADK's own session (every event it recorded) as an artifact."""

        async def dump() -> str | None:
            session = await self.sessions.get_session(
                app_name=APP_NAME, user_id=USER_ID, session_id=self.session_id
            )
            return session.model_dump_json(indent=1) if session else None

        data = self.loop.run(dump(), timeout=10)
        if data:
            ctx.write_artifact("adk-session.json", data)

    def teardown(self, ctx: TrialContext) -> None:
        async def close() -> None:
            await self.runner.close()
            for toolset in self.toolsets:
                await toolset.close()

        self.loop.run(close(), timeout=4)


def entry() -> None:
    main(AdkAdapter())


if __name__ == "__main__":
    entry()
