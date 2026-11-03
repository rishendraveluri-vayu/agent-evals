"""Compatibility with the official openai Python client, against a real uvicorn server.

The api_key below is a dummy string the client insists on; the fake ignores it.
"""

import json

import httpx
import openai
import pytest
from support import register

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_docs",
            "description": "Search the docs.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}, "limit": {"type": "integer"}},
                "required": ["query"],
            },
        },
    }
]
MESSAGES = [{"role": "user", "content": "What is the refund policy?"}]


def make_client(live, **kwargs):
    return openai.OpenAI(base_url=f"{live.url}/v1", api_key="not-a-real-key", **kwargs)


def test_streamed_tool_call_parses_in_openai_client(live):
    client = make_client(live, max_retries=0)
    expected = client.chat.completions.create(
        model="fake/two-tools", messages=MESSAGES, tools=TOOLS
    )
    with client.chat.completions.stream(
        model="fake/two-tools",
        messages=MESSAGES,
        tools=TOOLS,
        stream_options={"include_usage": True},
    ) as stream:
        for _ in stream:
            pass
        final = stream.get_final_completion()
    choice = final.choices[0]
    assert choice.finish_reason == "tool_calls"
    calls = choice.message.tool_calls
    assert len(calls) == 1
    assert calls[0].id == expected.choices[0].message.tool_calls[0].id
    assert calls[0].function.name == "search_docs"
    assert json.loads(calls[0].function.arguments) == {"query": "refund policy", "limit": 3}
    assert final.usage.total_tokens == expected.usage.total_tokens


def test_streamed_text_parses_in_openai_client(live):
    client = make_client(live, max_retries=0)
    stream = client.chat.completions.create(model="echo", messages=MESSAGES, stream=True)
    text = "".join(chunk.choices[0].delta.content or "" for chunk in stream if chunk.choices)
    assert text == "echo: What is the refund policy?"


def test_openai_client_retries_429_using_retry_after(live):
    with httpx.Client(base_url=live.url) as http:
        register(
            http,
            "quick-429",
            [{"text": "ok", "fault": {"kind": "429", "times": 2, "retry_after": 0.05}}],
        )
    client = make_client(live, max_retries=2)
    reply = client.chat.completions.create(model="quick-429", messages=MESSAGES)
    assert reply.choices[0].message.content == "ok"
    with httpx.Client(base_url=live.url) as http:
        statuses = [r["fault"] for r in http.get("/_fake/requests").json()["requests"]]
    assert statuses == ["429", "429", None]


def test_openai_client_without_retries_raises_rate_limit_error(live):
    client = make_client(live, max_retries=0)
    with pytest.raises(openai.RateLimitError):
        client.chat.completions.create(model="rate-limited", messages=MESSAGES)


def test_openai_client_raises_on_broken_stream(live):
    """A dropped stream must surface as an error, never as a silently shorter reply."""
    client = make_client(live, max_retries=0)
    stream = client.chat.completions.create(model="flaky-stream", messages=MESSAGES, stream=True)
    received = []
    with pytest.raises(openai.APIConnectionError):
        for chunk in stream:
            received.append(chunk)
    assert received, "chunks arrive before the break"
    assert all(c.choices[0].finish_reason is None for c in received)


def test_openai_client_raises_on_truncated_non_stream_body(live):
    client = make_client(live, max_retries=0)
    with pytest.raises(openai.APIConnectionError):
        client.chat.completions.create(model="flaky-stream", messages=MESSAGES)
    # The fault fired once; the client's own retry (or a second call) then succeeds.
    reply = client.chat.completions.create(model="flaky-stream", messages=MESSAGES)
    assert reply.choices[0].finish_reason == "stop"
