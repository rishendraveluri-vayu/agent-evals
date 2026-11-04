"""Chat completions: replies, streaming shape, step progression, usage."""

import json
import math

from fake_llm.render import canonical_json
from support import USER, chat_body, parse_sse, reassemble, register


def post(client, body):
    response = client.post("/v1/chat/completions", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def stream(client, body):
    with client.stream("POST", "/v1/chat/completions", json={**body, "stream": True}) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        return parse_sse(r.read().decode())


def test_non_stream_text(client):
    body = post(client, chat_body("echo"))
    assert body["object"] == "chat.completion"
    assert body["model"] == "echo"
    choice = body["choices"][0]
    assert choice["finish_reason"] == "stop"
    assert choice["message"]["role"] == "assistant"
    assert choice["message"]["content"] == "echo: What is the refund policy?"
    assert "tool_calls" not in choice["message"]


def test_usage_is_ceil_chars_over_four_and_deterministic(client):
    request = chat_body("echo")
    first, second = post(client, request), post(client, request)
    usage = first["usage"]
    assert usage["prompt_tokens"] == math.ceil(len(canonical_json(request["messages"])) / 4)
    assert usage["completion_tokens"] == math.ceil(len("echo: What is the refund policy?") / 4)
    assert usage["total_tokens"] == usage["prompt_tokens"] + usage["completion_tokens"]
    assert second["usage"] == usage


def test_prompt_tokens_include_tools(client):
    tools = [{"type": "function", "function": {"name": "f", "parameters": {"type": "object"}}}]
    without = post(client, chat_body("echo"))["usage"]["prompt_tokens"]
    with_tools = post(client, chat_body("echo", tools=tools))["usage"]["prompt_tokens"]
    expected = math.ceil(
        (len(canonical_json(chat_body()["messages"])) + len(canonical_json(tools))) / 4
    )
    assert with_tools == expected > without


def test_stream_text_reassembles_to_non_stream_content(client):
    register(client, "long-text", [{"text": "A reply long enough to span many chunks. " * 3}])
    for model in ("echo", "long-text"):
        expected = post(client, chat_body(model))["choices"][0]["message"]["content"]
        chunks, done = stream(client, chat_body(model))
        assert done
        assert len(chunks) > 2
        assert {c["object"] for c in chunks} == {"chat.completion.chunk"}
        assert len({c["id"] for c in chunks}) == 1
        assert chunks[0]["choices"][0]["delta"]["role"] == "assistant"
        message = reassemble(chunks)
        assert message["content"] == expected
        assert message["finish_reason"] == "stop"
        assert chunks[-1]["choices"][0]["finish_reason"] == "stop"
        assert all(c["choices"][0]["finish_reason"] is None for c in chunks[:-1])


def test_streamed_tool_calls_reassemble_to_non_stream_tool_calls(client):
    register(
        client,
        "parallel",
        [
            {
                "text": "Let me look that up.",
                "tool_calls": [
                    {"name": "search_docs", "arguments": {"query": "refund policy", "limit": 3}},
                    {"name": "get_time", "arguments": {}},
                    {"name": "read_file", "arguments": {"path": "a/very/long/path/name.md"}},
                ],
            }
        ],
    )
    for model in ("two-tools", "parallel"):
        expected = post(client, chat_body(model))["choices"][0]
        assert expected["finish_reason"] == "tool_calls"
        chunks, done = stream(client, chat_body(model))
        assert done
        message = reassemble(chunks)
        assert message["tool_calls"] == expected["message"]["tool_calls"]
        assert message["content"] == expected["message"]["content"]
        assert message["finish_reason"] == "tool_calls"
        for call in message["tool_calls"]:
            json.loads(call["function"]["arguments"])
        # The header delta for each call carries id, type, name and empty arguments.
        headers = [
            part
            for c in chunks
            for part in c["choices"][0]["delta"].get("tool_calls") or []
            if "id" in part
        ]
        assert [h["index"] for h in headers] == list(range(len(expected["message"]["tool_calls"])))
        assert all(h["type"] == "function" and h["function"]["arguments"] == "" for h in headers)


def test_tool_only_message_has_null_content(client):
    message = post(client, chat_body("two-tools"))["choices"][0]["message"]
    assert message["content"] is None
    assert message["tool_calls"][0]["function"]["name"] == "search_docs"
    assert json.loads(message["tool_calls"][0]["function"]["arguments"]) == {
        "query": "refund policy",
        "limit": 3,
    }


def test_tool_call_ids_are_deterministic(client):
    a = post(client, chat_body("two-tools"))["choices"][0]["message"]["tool_calls"][0]["id"]
    b = post(client, chat_body("two-tools"))["choices"][0]["message"]["tool_calls"][0]["id"]
    chunks, _ = stream(client, chat_body("two-tools"))
    assert a == b == reassemble(chunks)["tool_calls"][0]["id"]
    assert a.startswith("call_")


def test_step_progression_by_assistant_message_count(client):
    def turn(assistant_messages):
        messages = [{"role": "system", "content": "You are helpful."}, USER]
        for i in range(assistant_messages):
            call = {"id": f"c{i}", "type": "function", "function": {"name": "x", "arguments": "{}"}}
            messages.append({"role": "assistant", "content": None, "tool_calls": [call]})
            messages.append({"role": "tool", "tool_call_id": f"c{i}", "content": "result"})
        return post(client, chat_body("two-tools", messages=messages))["choices"][0]

    assert turn(0)["message"]["tool_calls"][0]["function"]["name"] == "search_docs"
    assert turn(1)["message"]["tool_calls"][0]["function"]["name"] == "read_file"
    final = turn(2)
    assert final["finish_reason"] == "stop"
    assert final["message"]["content"] == "Refunds are accepted within 30 days of purchase."
    # Past the last step, the last step is served again.
    assert turn(5)["message"]["content"] == final["message"]["content"]
    steps = [r["step"] for r in client.get("/_fake/requests").json()["requests"]]
    assert steps == [0, 1, 2, 2]


def test_include_usage_adds_final_usage_chunk(client):
    expected = post(client, chat_body("two-tools"))["usage"]
    chunks, done = stream(client, chat_body("two-tools", stream_options={"include_usage": True}))
    assert done
    last = chunks[-1]
    assert last["choices"] == []
    assert last["usage"] == expected
    assert all(c["usage"] is None for c in chunks[:-1])
    assert chunks[-2]["choices"][0]["finish_reason"] == "tool_calls"


def test_no_usage_chunk_without_include_usage(client):
    chunks, _ = stream(client, chat_body("echo"))
    assert all("usage" not in c for c in chunks)
    assert all(c["choices"] for c in chunks)


def test_response_model_echoes_request_model(client):
    assert post(client, chat_body("fake/echo"))["model"] == "fake/echo"


def test_completion_ids_are_unique(client):
    ids = {post(client, chat_body("echo"))["id"] for _ in range(3)}
    assert len(ids) == 3


def test_path_without_v1_prefix_also_works(client):
    response = client.post("/chat/completions", json=chat_body("echo"))
    assert response.status_code == 200
    assert client.get("/models").status_code == 200


def test_bad_requests_get_openai_style_400(client):
    response = client.post("/v1/chat/completions", content=b"{not json")
    assert response.status_code == 400
    assert response.json()["error"]["type"] == "invalid_request_error"
    response = client.post("/v1/chat/completions", json={"model": "echo"})
    assert response.status_code == 400
    assert client.get("/_fake/requests").json()["requests"] == []


def test_unknown_route_is_json_404(client):
    response = client.get("/v1/nope")
    assert response.status_code == 404
    assert response.json()["error"]["message"] == "Not Found"


def _tool(name):
    return {"type": "function", "function": {"name": name, "parameters": {"type": "object"}}}


def test_scripted_tool_name_matches_a_prefixed_tool(client):
    register(client, "one-tool", [{"tool_calls": [{"name": "calculate_emi", "arguments": {}}]}])
    names = {
        "bare": ["calculate_emi", "list_debts"],
        "hermes": ["mcp__finance__calculate_emi", "mcp__finance__list_debts"],
        "none": [],
        "ambiguous": ["mcp__a__calculate_emi", "mcp__b__calculate_emi"],
        "unrelated": ["search_docs"],
    }
    expected = {
        "bare": "calculate_emi",
        "hermes": "mcp__finance__calculate_emi",
        "none": "calculate_emi",
        "ambiguous": "calculate_emi",
        "unrelated": "calculate_emi",
    }
    for case, tool_names in names.items():
        tools = [_tool(n) for n in tool_names]
        body = post(client, chat_body("one-tool", tools=tools) if tools else chat_body("one-tool"))
        call = body["choices"][0]["message"]["tool_calls"][0]
        assert call["function"]["name"] == expected[case], case


def test_sim_empty_replies_with_no_text(client):
    """The simulated client that says nothing, for the adapter library's sim_error tests."""
    messages = [
        {"role": "system", "content": "You are the client."},
        {"role": "assistant", "content": "I don't know where to start."},  # the opening message
        {"role": "user", "content": "Tell me about your loans."},  # the agent's reply
    ]
    choice = post(client, chat_body("fake/sim-empty", messages=messages))["choices"][0]
    assert choice["message"]["content"] == ""
    assert choice["finish_reason"] == "stop"
    assert "tool_calls" not in choice["message"]
    # Every later turn is empty too.
    later = [
        *messages,
        {"role": "assistant", "content": "OK."},
        {"role": "user", "content": "Anything else?"},
    ]
    again = post(client, chat_body("fake/sim-empty", messages=later))["choices"][0]
    assert again["message"]["content"] == ""
    chunks, done = stream(client, chat_body("fake/sim-empty", messages=messages))
    assert done
    assert not reassemble(chunks)["content"]
    steps = [r["step"] for r in client.get("/_fake/requests").json()["requests"]]
    assert steps == [1, 1, 1]
