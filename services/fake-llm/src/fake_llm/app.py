"""The fake OpenAI-compatible server: routes and request handling."""

import json
import logging
import math
import os
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from fake_llm import scripts as script_lib
from fake_llm.asgi import NoResponse, SSEResponse, TruncatedResponse, sleep_unless_disconnected
from fake_llm.render import (
    ResponseMeta,
    completion_body,
    fault_identity,
    render_step,
    stream_events,
)
from fake_llm.state import FaultCounter, RequestLog

log = logging.getLogger("fake_llm")

CAPTURE_SIZE = 2000

# Status faults: (default message, OpenAI error type, code). A script's fault.message replaces
# the message, for example to look like a provider's own 400 wording.
STATUS_ERRORS: dict[str, tuple[str, str, str | None]] = {
    "400": ("Invalid request", "invalid_request_error", None),
    "401": ("Incorrect API key provided", "invalid_request_error", "invalid_api_key"),
    "403": ("You are not allowed to use this model", "invalid_request_error", None),
    "404": ("The model does not exist", "invalid_request_error", "model_not_found"),
    "429": ("Rate limit reached", "requests", "rate_limit_exceeded"),
    "500": ("The server had an error while processing your request", "server_error", None),
    "502": ("Bad gateway", "server_error", None),
    "503": (
        "This model is currently experiencing high demand. Please try again later",
        "server_error",
        None,
    ),
}
assert set(STATUS_ERRORS) == set(script_lib.STATUS_FAULTS)


@dataclass
class FakeState:
    registry: script_lib.Registry
    faults: FaultCounter
    requests: RequestLog


def openai_error(
    status: int,
    message: str,
    error_type: str,
    code: str | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    body = {"error": {"message": message, "type": error_type, "param": None, "code": code}}
    return JSONResponse(body, status_code=status, headers=headers)


def _state(request: Request) -> FakeState:
    return request.app.state.fake


async def chat_completions(request: Request) -> Any:
    state = _state(request)
    try:
        body = json.loads(await request.body())
    except json.JSONDecodeError, UnicodeDecodeError:
        return openai_error(400, "Request body is not valid JSON.", "invalid_request_error")
    if not isinstance(body, dict) or not isinstance(body.get("messages"), list):
        return openai_error(400, "'messages' must be a list.", "invalid_request_error")

    messages = body["messages"]
    selection = script_lib.select_script(body, state.registry)
    script = selection.script
    assistant_messages = sum(
        1 for m in messages if isinstance(m, dict) and m.get("role") == "assistant"
    )
    step_index, step = script.step_for(assistant_messages)
    stream = body.get("stream") is True
    stream_options = body.get("stream_options")
    include_usage = (
        stream and isinstance(stream_options, dict) and stream_options.get("include_usage") is True
    )

    # Decide the fault before any await, so concurrent identical attempts count exactly once each.
    fault = step.fault
    if fault is not None:
        identity = fault_identity(script.name, step_index, messages)
        if not state.faults.should_fire(identity, fault.times):
            fault = None

    entry = state.requests.add(
        script=script.name,
        requested_script=selection.requested,
        selected_by=selection.selected_by,
        fell_back=selection.fell_back,
        step=step_index,
        stream=stream,
        fault=fault.kind if fault else None,
        body=body,
    )

    def done(outcome: str) -> None:
        entry["outcome"] = outcome

    log.info(
        "seq=%s script=%s step=%s stream=%s fault=%s",
        entry["seq"],
        script.name,
        step_index,
        stream,
        entry["fault"],
    )

    if step.delay_ms and await sleep_unless_disconnected(request.receive, step.delay_ms / 1000):
        done("client_disconnected")
        return NoResponse()

    kind = fault.kind if fault else None
    if fault is not None and kind in STATUS_ERRORS:
        done("completed")
        message, error_type, code = STATUS_ERRORS[kind]
        headers = None
        if kind == "429":
            headers = {
                "retry-after": str(math.ceil(fault.retry_after)),
                "retry-after-ms": str(round(fault.retry_after * 1000)),
            }
        return openai_error(
            int(kind),
            fault.message or f"{message} (fake-llm forced fault).",
            error_type,
            code=code,
            headers=headers,
        )
    if kind == "timeout" and await sleep_unless_disconnected(request.receive, fault.seconds):
        done("client_disconnected")
        return NoResponse()

    rendered = render_step(
        step,
        script=script.name,
        step_index=step_index,
        body=body,
        malformed=kind == "malformed_tool_call",
    )
    model = body.get("model") if isinstance(body.get("model"), str) else script.name
    meta = ResponseMeta(id=f"chatcmpl-{uuid.uuid4().hex}", created=int(time.time()), model=model)
    broken = kind == "broken_stream"

    if stream:
        events = stream_events(rendered, meta, include_usage=include_usage, broken=broken)
        return SSEResponse(
            events, complete=not broken, chunk_delay=step.chunk_delay_ms / 1000, on_done=done
        )
    payload = completion_body(rendered, meta)
    if broken:
        return TruncatedResponse(json.dumps(payload).encode(), on_done=done)
    done("completed")
    return JSONResponse(payload)


async def list_models(request: Request) -> JSONResponse:
    data = [
        {"id": s.name, "object": "model", "created": 0, "owned_by": "fake-llm"}
        for s in _state(request).registry.all()
    ]
    return JSONResponse({"object": "list", "data": data})


async def health(request: Request) -> JSONResponse:
    return JSONResponse({"status": "ok"})


async def get_requests(request: Request) -> JSONResponse:
    script = request.query_params.get("script")
    return JSONResponse({"requests": _state(request).requests.list(script=script)})


async def clear_requests(request: Request) -> JSONResponse:
    return JSONResponse({"cleared": _state(request).requests.clear()})


async def clear_faults(request: Request) -> JSONResponse:
    return JSONResponse({"cleared": _state(request).faults.reset()})


async def list_scripts(request: Request) -> JSONResponse:
    scripts = [
        {"name": s.name, "source": s.source, "steps": len(s.steps), "definition": s.definition}
        for s in _state(request).registry.all()
    ]
    return JSONResponse({"scripts": scripts})


async def register_script(request: Request) -> JSONResponse:
    try:
        data = json.loads(await request.body())
        script = script_lib.parse_script(data, source="runtime")
    except json.JSONDecodeError, UnicodeDecodeError:
        return openai_error(400, "Request body is not valid JSON.", "invalid_request_error")
    except script_lib.ScriptError as exc:
        return openai_error(400, str(exc), "invalid_request_error")
    replaced = _state(request).registry.add(script)
    return JSONResponse(
        {"name": script.name, "steps": len(script.steps), "replaced": replaced},
        status_code=200 if replaced else 201,
    )


async def http_error(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, HTTPException)
    return openai_error(exc.status_code, str(exc.detail), "invalid_request_error")


def create_app(
    scripts_dir: Path | str | None = None, *, capture_size: int = CAPTURE_SIZE
) -> Starlette:
    """Build the app. Scripts come from `scripts_dir` (if given) plus the built-in default."""
    registry = script_lib.Registry()
    if scripts_dir is not None:
        for script in script_lib.load_dir(Path(scripts_dir)):
            registry.add(script)
    routes = [
        Route("/v1/chat/completions", chat_completions, methods=["POST"]),
        Route("/chat/completions", chat_completions, methods=["POST"]),
        Route("/v1/models", list_models, methods=["GET"]),
        Route("/models", list_models, methods=["GET"]),
        Route("/health", health, methods=["GET"]),
        Route("/_fake/requests", get_requests, methods=["GET"]),
        Route("/_fake/requests", clear_requests, methods=["DELETE"]),
        Route("/_fake/faults", clear_faults, methods=["DELETE"]),
        Route("/_fake/scripts", list_scripts, methods=["GET"]),
        Route("/_fake/scripts", register_script, methods=["POST"]),
    ]
    app = Starlette(routes=routes, exception_handlers={HTTPException: http_error})
    app.state.fake = FakeState(registry, FaultCounter(), RequestLog(capture_size))
    log.info("loaded scripts: %s", ", ".join(s.name for s in registry.all()))
    return app


def scripts_dir_from_env() -> Path | None:
    """FAKE_LLM_SCRIPTS_DIR if set (it must exist), else ./scripts if present, else none."""
    configured = os.environ.get("FAKE_LLM_SCRIPTS_DIR")
    if configured:
        path = Path(configured)
        if not path.is_dir():
            raise SystemExit(f"FAKE_LLM_SCRIPTS_DIR={configured!r} is not a directory")
        return path
    fallback = Path.cwd() / "scripts"
    if fallback.is_dir():
        return fallback
    log.warning("no scripts directory found; only the built-in 'default' script is loaded")
    return None


def app_from_env() -> Starlette:
    """Factory for `uvicorn --factory fake_llm.app:app_from_env`."""
    return create_app(scripts_dir_from_env())
