"""Forced faults (429, 500, timeout, broken stream, malformed tool call), `times` counting,
and injected latency."""

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
from fake_llm.state import FaultCounter
from support import chat_body, parse_sse, reassemble, register


def captured(client):
    return client.get("/_fake/requests").json()["requests"]


def wait_for_outcome(client, seq, outcome, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        entry = next(r for r in captured(client) if r["seq"] == seq)
        if entry["outcome"] == outcome:
            return entry
        time.sleep(0.02)
    raise AssertionError(f"seq {seq} never reached outcome {outcome!r}: {entry}")


def test_429_twice_then_success(client):
    request = chat_body("rate-limited")
    for _ in range(2):
        response = client.post("/v1/chat/completions", json=request)
        assert response.status_code == 429
        assert response.headers["retry-after"] == "1"
        assert response.headers["retry-after-ms"] == "1000"
        error = response.json()["error"]
        assert error["code"] == "rate_limit_exceeded"
        assert set(error) == {"message", "type", "param", "code"}
    response = client.post("/v1/chat/completions", json=request)
    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"].startswith("Succeeded")
    assert [r["fault"] for r in captured(client)] == ["429", "429", None]


def test_fault_identity_depends_on_messages_and_reset(client):
    other = chat_body("rate-limited", messages=[{"role": "user", "content": "different"}])
    assert client.post("/v1/chat/completions", json=chat_body("rate-limited")).status_code == 429
    assert client.post("/v1/chat/completions", json=other).status_code == 429
    assert client.post("/v1/chat/completions", json=chat_body("rate-limited")).status_code == 429
    assert client.post("/v1/chat/completions", json=chat_body("rate-limited")).status_code == 200
    assert client.delete("/_fake/faults").json() == {"cleared": 2}
    assert client.post("/v1/chat/completions", json=chat_body("rate-limited")).status_code == 429


def test_429_stream_request_gets_error_before_stream(client):
    response = client.post("/v1/chat/completions", json=chat_body("rate-limited", stream=True))
    assert response.status_code == 429
    assert response.headers["content-type"] == "application/json"


def test_500_always(client):
    register(client, "down", [{"fault": {"kind": 500}}])
    for _ in range(3):
        response = client.post("/v1/chat/completions", json=chat_body("down"))
        assert response.status_code == 500
        assert response.json()["error"]["type"] == "server_error"


@pytest.mark.parametrize(
    ("kind", "error_type"),
    [
        ("400", "invalid_request_error"),
        ("401", "invalid_request_error"),
        ("403", "invalid_request_error"),
        ("404", "invalid_request_error"),
        ("502", "server_error"),
        ("503", "server_error"),
    ],
)
def test_status_faults(client, kind, error_type):
    register(client, f"status-{kind}", [{"fault": {"kind": kind}}])
    response = client.post("/v1/chat/completions", json=chat_body(f"status-{kind}"))
    assert response.status_code == int(kind)
    error = response.json()["error"]
    assert error["type"] == error_type
    assert error["message"].endswith("(fake-llm forced fault).")
    assert "retry-after" not in response.headers  # only a 429 says when to come back
    assert captured(client)[-1]["fault"] == kind


def test_status_fault_message_override(client):
    register(client, "rejected", [{"fault": {"kind": 400, "message": "`temperature` is bad."}}])
    response = client.post("/v1/chat/completions", json=chat_body("rejected"))
    assert response.status_code == 400
    assert response.json()["error"]["message"] == "`temperature` is bad."


def test_503_twice_script_then_tool_call(client):
    responses = [
        client.post("/v1/chat/completions", json=chat_body("finance-503-twice")) for _ in range(3)
    ]
    assert [r.status_code for r in responses] == [503, 503, 200]
    assert responses[2].json()["choices"][0]["finish_reason"] == "tool_calls"


def test_malformed_tool_call_arguments(client):
    register(
        client,
        "bad-args",
        [
            {
                "tool_calls": [{"name": "search_docs", "arguments": {"query": "x"}}],
                "fault": {"kind": "malformed_tool_call", "times": 1},
            }
        ],
    )
    first = client.post("/v1/chat/completions", json=chat_body("bad-args")).json()
    arguments = first["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
    with pytest.raises(json.JSONDecodeError):
        json.loads(arguments)
    assert first["choices"][0]["finish_reason"] == "tool_calls"
    second = client.post("/v1/chat/completions", json=chat_body("bad-args")).json()
    arguments = second["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
    assert json.loads(arguments) == {"query": "x"}


def test_malformed_tool_call_when_streamed(client):
    register(
        client,
        "bad-args-always",
        [
            {
                "tool_calls": [{"name": "a", "arguments": {}}, {"name": "b", "arguments": "[1]"}],
                "fault": {"kind": "malformed_tool_call"},
            }
        ],
    )
    request = chat_body("bad-args-always", stream=True)
    with client.stream("POST", "/v1/chat/completions", json=request) as response:
        chunks, done = parse_sse(response.read().decode())
    assert done
    for call in reassemble(chunks)["tool_calls"]:
        with pytest.raises(json.JSONDecodeError):
            json.loads(call["function"]["arguments"])


def test_delay_ms(client):
    register(client, "slow", [{"text": "ok", "delay_ms": 150}])
    start = time.monotonic()
    assert client.post("/v1/chat/completions", json=chat_body("slow")).status_code == 200
    assert time.monotonic() - start >= 0.15


def test_chunk_delay_ms_spaces_stream_chunks(live):
    with httpx.Client(base_url=live.url, timeout=5) as http:
        register(http, "slow-stream", [{"text": "x" * 24, "chunk_delay_ms": 50}])
        start = time.monotonic()
        with http.stream(
            "POST", "/v1/chat/completions", json=chat_body("slow-stream", stream=True)
        ) as response:
            chunks, done = parse_sse(response.read().decode())
        elapsed = time.monotonic() - start
    # role chunk + 3 content chunks + finish chunk + [DONE] = 6 events, 5 gaps of 50 ms
    assert done and reassemble(chunks)["content"] == "x" * 24
    assert elapsed >= 0.25


def test_stream_stops_when_client_disconnects_mid_stream(live):
    with httpx.Client(base_url=live.url, timeout=5) as http:
        register(http, "very-slow-stream", [{"text": "y" * 400, "chunk_delay_ms": 200}])
        with http.stream(
            "POST", "/v1/chat/completions", json=chat_body("very-slow-stream", stream=True)
        ) as response:
            next(response.iter_lines())  # read the first event, then hang up
    with httpx.Client(base_url=live.url) as http:
        seq = captured(http)[-1]["seq"]
        wait_for_outcome(http, seq, "client_disconnected")


def test_timeout_fires_client_timeout_then_succeeds(live):
    with httpx.Client(base_url=live.url) as http:
        register(
            http,
            "hangs-once",
            [{"text": "late", "fault": {"kind": "timeout", "seconds": 1, "times": 1}}],
        )
        with pytest.raises(httpx.ReadTimeout):
            http.post("/v1/chat/completions", json=chat_body("hangs-once"), timeout=0.2)
        response = http.post("/v1/chat/completions", json=chat_body("hangs-once"), timeout=0.5)
        assert response.status_code == 200
        assert response.json()["choices"][0]["message"]["content"] == "late"


def test_timeout_sleep_stops_when_client_disconnects(live):
    """A 30 s timeout fault must not hold the server for 30 s once the client gave up."""
    with httpx.Client(base_url=live.url) as http:
        register(http, "hangs", [{"text": "never", "fault": {"kind": "timeout"}}])
    with httpx.Client(base_url=live.url) as http, pytest.raises(httpx.ReadTimeout):
        http.post("/v1/chat/completions", json=chat_body("hangs"), timeout=0.2)
    with httpx.Client(base_url=live.url) as http:
        seq = captured(http)[-1]["seq"]
        entry = wait_for_outcome(http, seq, "client_disconnected")
        assert entry["fault"] == "timeout"


def read_broken_stream(http, body):
    lines = []
    with http.stream("POST", "/v1/chat/completions", json={**body, "stream": True}) as response:
        assert response.status_code == 200
        with pytest.raises(httpx.RemoteProtocolError):
            for line in response.iter_lines():
                lines.append(line)
    return parse_sse("\n".join(lines) + "\n\n")


def test_broken_stream_text_then_clean_retry(live):
    with httpx.Client(base_url=live.url, timeout=2) as http:
        chunks, done = read_broken_stream(http, chat_body("flaky-stream"))
        assert not done
        assert chunks, "some chunks arrive before the break"
        assert all(c["choices"][0]["finish_reason"] is None for c in chunks)
        partial = reassemble(chunks)["content"]
        with http.stream(
            "POST", "/v1/chat/completions", json=chat_body("flaky-stream", stream=True)
        ) as response:
            chunks, done = parse_sse(response.read().decode())
        assert done
        expected_text = reassemble(chunks)["content"]
        assert expected_text.startswith(partial) and len(partial) < len(expected_text)
        outcomes = [r["outcome"] for r in captured(http)]
        assert outcomes == ["connection_dropped", "completed"]


def test_broken_stream_tool_call_sends_partial_arguments(live):
    with httpx.Client(base_url=live.url, timeout=2) as http:
        register(
            http,
            "broken-tool",
            [
                {
                    "tool_calls": [
                        {"name": "search_docs", "arguments": {"query": "refund policy"}}
                    ],
                    "fault": {"kind": "broken_stream"},
                }
            ],
        )
        chunks, done = read_broken_stream(http, chat_body("broken-tool"))
    assert not done
    call = reassemble(chunks)["tool_calls"][0]
    assert call["function"]["name"] == "search_docs"
    full = json.dumps({"query": "refund policy"})
    assert full.startswith(call["function"]["arguments"])
    assert 0 < len(call["function"]["arguments"]) < len(full)


def test_broken_non_stream_is_truncated_body(live):
    with httpx.Client(base_url=live.url, timeout=2) as http:
        with pytest.raises(httpx.RemoteProtocolError):
            http.post("/v1/chat/completions", json=chat_body("flaky-stream"))
        response = http.post("/v1/chat/completions", json=chat_body("flaky-stream"))
        assert response.status_code == 200


def test_concurrent_identical_requests_count_faults_exactly(live):
    total, times = 40, 7
    with httpx.Client(base_url=live.url, timeout=5) as http:
        register(http, "burst", [{"text": "ok", "fault": {"kind": "429", "times": times}}])
        barrier = threading.Barrier(total)

        def attempt(_):
            barrier.wait()
            return http.post("/v1/chat/completions", json=chat_body("burst")).status_code

        with ThreadPoolExecutor(max_workers=total) as pool:
            statuses = list(pool.map(attempt, range(total)))
        assert statuses.count(429) == times
        assert statuses.count(200) == total - times
        assert sum(r["fault"] == "429" for r in captured(http)) == times


def test_fault_counter_is_exact_under_threads():
    counter, times, threads, per_thread = FaultCounter(), 100, 8, 500
    fired = []
    barrier = threading.Barrier(threads)

    def hammer():
        barrier.wait()
        fired.append(sum(counter.should_fire("same", times) for _ in range(per_thread)))

    workers = [threading.Thread(target=hammer) for _ in range(threads)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join()
    assert sum(fired) == times


def test_fault_counter_without_times_always_fires():
    counter = FaultCounter()
    assert all(counter.should_fire("x", None) for _ in range(10))
    assert counter.reset() == 0
