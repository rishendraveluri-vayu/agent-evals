"""Turn a script step into OpenAI Chat Completions payloads (non-stream body or stream chunks)."""

import hashlib
import json
import math
from dataclasses import dataclass, field
from typing import Any

from fake_llm.scripts import LAST_USER_PLACEHOLDER, Step, message_text

CHUNK_CHARS = 8  # stream text and tool arguments in fragments of this many characters
SYSTEM_FINGERPRINT = "fake-llm"


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def count_tokens(text: str) -> int:
    """Deterministic stand-in for a tokenizer: ceil(characters / 4)."""
    return math.ceil(len(text) / 4)


def prompt_tokens(body: dict[str, Any]) -> int:
    """Tokens over the canonical JSON of `messages`, plus `tools` when the request has them."""
    chars = len(canonical_json(body.get("messages", [])))
    if body.get("tools"):
        chars += len(canonical_json(body["tools"]))
    return math.ceil(chars / 4)


def tool_call_id(script: str, step: int, position: int) -> str:
    digest = hashlib.sha256(f"{script}\x00{step}\x00{position}".encode()).hexdigest()
    return f"call_{digest[:24]}"


def fault_identity(script: str, step: int, messages: Any) -> str:
    """Identity of an attempt for `times` counting: script, step and canonical messages."""
    return hashlib.sha256(canonical_json([script, step, messages]).encode()).hexdigest()


def malform(arguments: str) -> str:
    """Make tool arguments invalid JSON the way a cut-off model does: drop the closing brace.

    A JSON object minus its final '}' never parses. A raw string that is not an object gets
    an unmatched '{' prefix instead, which also never parses.
    """
    stripped = arguments.rstrip()
    if stripped.endswith("}"):
        return stripped[:-1]
    return "{" + arguments


def resolve_tool_name(name: str, body: dict[str, Any]) -> str:
    """Match a scripted tool name to the request's tools, so one script serves every harness.

    Harnesses name the same MCP tool differently: Hermes sends `mcp__finance__calculate_emi`,
    others send `calculate_emi`. An exact match wins. Otherwise, if exactly one tool in the
    request ends with `__<name>`, that name is used. Anything else is sent as scripted, which is
    how a test calls an unknown tool on purpose.
    """
    names = [
        t.get("function", {}).get("name")
        for t in body.get("tools") or []
        if isinstance(t, dict) and isinstance(t.get("function"), dict)
    ]
    if name in names:
        return name
    matches = [n for n in names if isinstance(n, str) and n.endswith("__" + name)]
    return matches[0] if len(matches) == 1 else name


def last_user_text(messages: list[Any]) -> str:
    for message in reversed(messages):
        if isinstance(message, dict) and message.get("role") == "user":
            return message_text(message.get("content"))
    return ""


def fragments(text: str, size: int = CHUNK_CHARS) -> list[str]:
    return [text[i : i + size] for i in range(0, len(text), size)]


@dataclass
class Rendered:
    """What the assistant says for one request, independent of streaming."""

    content: str | None
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    usage: dict[str, Any] = field(default_factory=dict)

    @property
    def finish_reason(self) -> str:
        return "tool_calls" if self.tool_calls else "stop"


def render_step(
    step: Step, *, script: str, step_index: int, body: dict[str, Any], malformed: bool
) -> Rendered:
    messages = body.get("messages", [])
    content = step.text
    if content is not None and LAST_USER_PLACEHOLDER in content:
        content = content.replace(LAST_USER_PLACEHOLDER, last_user_text(messages))
    tool_calls = []
    for position, call in enumerate(step.tool_calls):
        arguments = malform(call.arguments) if malformed else call.arguments
        tool_calls.append(
            {
                "id": tool_call_id(script, step_index, position),
                "type": "function",
                "function": {"name": resolve_tool_name(call.name, body), "arguments": arguments},
            }
        )
    output = (content or "") + "".join(
        tc["function"]["name"] + tc["function"]["arguments"] for tc in tool_calls
    )
    prompt, completion = prompt_tokens(body), count_tokens(output)
    usage = {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": prompt + completion,
        "prompt_tokens_details": {"cached_tokens": 0},
        "completion_tokens_details": {"reasoning_tokens": 0},
    }
    if content is None and not tool_calls:
        content = ""  # a fault-only step that is served anyway still returns a message
    return Rendered(content=content, tool_calls=tool_calls, usage=usage)


@dataclass(frozen=True)
class ResponseMeta:
    id: str
    created: int
    model: str


def completion_body(rendered: Rendered, meta: ResponseMeta) -> dict[str, Any]:
    message: dict[str, Any] = {
        "role": "assistant",
        "content": rendered.content if rendered.content or not rendered.tool_calls else None,
        "refusal": None,
    }
    if rendered.tool_calls:
        message["tool_calls"] = rendered.tool_calls
    return {
        "id": meta.id,
        "object": "chat.completion",
        "created": meta.created,
        "model": meta.model,
        "system_fingerprint": SYSTEM_FINGERPRINT,
        "choices": [
            {
                "index": 0,
                "message": message,
                "logprobs": None,
                "finish_reason": rendered.finish_reason,
            }
        ],
        "usage": rendered.usage,
    }


def stream_deltas(rendered: Rendered) -> list[dict[str, Any]]:
    """Deltas after the role chunk, in OpenAI's order: content fragments, then each tool call
    as a header delta (index, id, type, name, empty arguments) followed by argument-only deltas.
    """
    deltas: list[dict[str, Any]] = [
        {"content": piece} for piece in fragments(rendered.content or "")
    ]
    for index, call in enumerate(rendered.tool_calls):
        deltas.append(
            {
                "tool_calls": [
                    {
                        "index": index,
                        "id": call["id"],
                        "type": "function",
                        "function": {"name": call["function"]["name"], "arguments": ""},
                    }
                ]
            }
        )
        for piece in fragments(call["function"]["arguments"]):
            deltas.append({"tool_calls": [{"index": index, "function": {"arguments": piece}}]})
    return deltas


def sse(data: dict[str, Any] | str) -> bytes:
    payload = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False)
    return f"data: {payload}\n\n".encode()


def stream_events(
    rendered: Rendered, meta: ResponseMeta, *, include_usage: bool, broken: bool
) -> list[bytes]:
    """SSE events for a streamed reply.

    A broken stream sends the role chunk and the first half (rounded up) of the deltas, then
    stops: no finish_reason, no usage chunk, no [DONE]. The caller then drops the connection.
    """

    def chunk(delta: dict[str, Any], finish_reason: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {
            "id": meta.id,
            "object": "chat.completion.chunk",
            "created": meta.created,
            "model": meta.model,
            "system_fingerprint": SYSTEM_FINGERPRINT,
            "choices": [
                {"index": 0, "delta": delta, "logprobs": None, "finish_reason": finish_reason}
            ],
        }
        if include_usage:
            body["usage"] = None
        return body

    first_content = "" if rendered.content or not rendered.tool_calls else None
    deltas = stream_deltas(rendered)
    if broken:
        deltas = deltas[: math.ceil(len(deltas) / 2)]
    events = [sse(chunk({"role": "assistant", "content": first_content, "refusal": None}))]
    events += [sse(chunk(delta)) for delta in deltas]
    if broken:
        return events
    events.append(sse(chunk({}, rendered.finish_reason)))
    if include_usage:
        usage_chunk = chunk({})
        usage_chunk["choices"] = []
        usage_chunk["usage"] = rendered.usage
        events.append(sse(usage_chunk))
    events.append(sse("[DONE]"))
    return events
