"""Helpers shared by the tests: request builders and an independent SSE reassembler."""

import json
from typing import Any

USER = {"role": "user", "content": "What is the refund policy?"}


def chat_body(model: str = "echo", messages: list[dict] | None = None, **extra: Any) -> dict:
    return {"model": model, "messages": messages if messages is not None else [USER], **extra}


def parse_sse(raw: str) -> tuple[list[dict], bool]:
    """Split an SSE body into JSON chunks. Returns (chunks, saw_done)."""
    chunks: list[dict] = []
    done = False
    for block in raw.split("\n\n"):
        block = block.strip()
        if not block:
            continue
        assert block.startswith("data: "), block
        data = block.removeprefix("data: ")
        if data == "[DONE]":
            done = True
            continue
        assert not done, "data after [DONE]"
        chunks.append(json.loads(data))
    return chunks, done


def reassemble(chunks: list[dict]) -> dict:
    """Rebuild the assistant message the way a client must: concatenate content, start a tool
    call on each delta that carries an id, append argument fragments by index."""
    content: str | None = None
    calls: dict[int, dict] = {}
    finish_reason = None
    for chunk in chunks:
        for choice in chunk["choices"]:
            delta = choice["delta"]
            if delta.get("content") is not None:
                content = (content or "") + delta["content"]
            for part in delta.get("tool_calls") or []:
                if "id" in part:
                    assert part["index"] not in calls, "tool call header sent twice"
                    calls[part["index"]] = {
                        "id": part["id"],
                        "type": part["type"],
                        "function": {
                            "name": part["function"]["name"],
                            "arguments": part["function"].get("arguments", ""),
                        },
                    }
                else:
                    assert set(part) == {"index", "function"}, part
                    assert set(part["function"]) == {"arguments"}, part
                    calls[part["index"]]["function"]["arguments"] += part["function"]["arguments"]
            if choice["finish_reason"] is not None:
                finish_reason = choice["finish_reason"]
    return {
        "content": content,
        "tool_calls": [calls[i] for i in sorted(calls)],
        "finish_reason": finish_reason,
    }


def register(client: Any, name: str, steps: list[dict]) -> None:
    response = client.post("/_fake/scripts", json={"name": name, "steps": steps})
    assert response.status_code in (200, 201), response.text
