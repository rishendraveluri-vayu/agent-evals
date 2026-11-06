"""Merging LiteLLM's spend-log rows into the trace. Row shapes copied from LiteLLM v1.99.4
(checked 3 Nov against the compose proxy and the fake model)."""

import json
import re
import time

from support import CONTRACT, REPO, attrs, errors, read_jsonl

from evals_adapter.proxy import SPEND_LOG_QUIET_S, ProxyClient, call_status, merge_proxy_spans
from evals_adapter.runner import _sim_calls, label
from evals_adapter.spec import TrialPaths
from evals_adapter.trace import Tracer, trace_id_for


def row(n, start, end, status="success", code=None, messages=None, spend=0.000034, retries=0):
    # attempted_retries is LiteLLM's count of its own retries for the call (D16); a call refused
    # before routing (a budget stop) has None.
    meta = {"error_information": None, "attempted_retries": retries, "max_retries": 3}
    if status != "success":
        meta["error_information"] = {
            "error_code": code,
            "error_message": "Rate limit reached",
            "error_budget_limit": "None",
        }
    return {
        "request_id": f"req-{n}",
        "status": status,
        "model": "openai/finance-emi",
        "model_group": "fake/finance-emi",
        "prompt_tokens": 8,
        "completion_tokens": 13 if status == "success" else 0,
        "spend": spend if status == "success" else 0.0,
        "startTime": start,
        "endTime": end,
        "metadata": meta,
        "proxy_server_request": {
            "model": "fake/finance-emi",
            "messages": messages or [{"role": "user", "content": "hi"}],
            "temperature": 0.2,
            "max_tokens": 1024,
            "tools": [{"type": "function"}],
            "litellm_call_id": "x",
            "metadata": {"headers": {"host": "litellm:4000", "user-agent": "OpenAI/Python"}},
        },
        "response": {"choices": [{"finish_reason": "tool_calls"}]} if status == "success" else {},
    }


def make_trace(tmp_path, turns):
    paths = TrialPaths(tmp_path)
    paths.out.mkdir(parents=True)
    tracer = Tracer(paths.trace, "t_1")
    root = tracer.start("invoke_agent x")
    for start, _end in turns:
        span = tracer.start("agent.turn", parent=root, start_ns=start)
        span.end(ok=True)  # ends "now"; the window is rewritten below
    root.end(ok=True)
    tracer.close()
    spans = read_jsonl(paths.trace)
    for span, (start, end) in zip(
        [s for s in spans if s["name"] == "agent.turn"], turns, strict=True
    ):
        span["startTimeUnixNano"], span["endTimeUnixNano"] = str(start), str(end)
    paths.trace.write_text("".join(json.dumps(s) + "\n" for s in spans))
    return paths, spans


def ns(iso):
    from evals_adapter.proxy import iso_to_ns

    return iso_to_ns(iso)


def test_chat_spans_go_under_the_turn_they_happened_in(tmp_path):
    t1 = (ns("2026-11-03T10:00:00Z"), ns("2026-11-03T10:00:10Z"))
    t2 = (ns("2026-11-03T10:00:20Z"), ns("2026-11-03T10:00:30Z"))
    paths, spans = make_trace(tmp_path, [t1, t2])
    records = [
        row(1, "2026-11-03T10:00:01.000Z", "2026-11-03T10:00:02.000Z"),
        row(2, "2026-11-03T10:00:21.000Z", "2026-11-03T10:00:22.000Z"),
    ]
    assert merge_proxy_spans(paths, records, "t_1") == 2
    merged = read_jsonl(paths.trace)
    turns = [s for s in merged if s["name"] == "agent.turn"]
    chats = [s for s in merged if s["name"].startswith("chat ")]
    assert [c["parentSpanId"] for c in chats] == [turns[0]["spanId"], turns[1]["spanId"]]
    for span in merged:
        assert errors("span", span) == []
    a = attrs(chats[0])
    assert a["evals.source"] == "proxy"
    assert a["gen_ai.request.model"] == "fake/finance-emi"
    assert a["gen_ai.usage.output_tokens"] == 13
    assert a["evals.cost_usd"] == 0.000034
    assert a["gen_ai.response.finish_reasons"] == ["tool_calls"]
    assert chats[0]["traceId"] == trace_id_for("t_1")
    body = json.loads((paths.out / a["evals.request_ref"]).read_text())
    assert "metadata" not in body and "litellm_call_id" not in body
    assert body["_headers_seen"] == ["host", "user-agent"]


def test_hidden_retries_show_as_extra_attempts(tmp_path):
    paths, _ = make_trace(tmp_path, [(ns("2026-11-03T10:00:00Z"), ns("2026-11-03T10:01:00Z"))])
    same = [{"role": "user", "content": "same"}]
    records = [
        row(1, "2026-11-03T10:00:01Z", "2026-11-03T10:00:01.1Z", "failure", "429", same),
        row(2, "2026-11-03T10:00:02Z", "2026-11-03T10:00:02.1Z", "failure", "429", same),
        row(3, "2026-11-03T10:00:03Z", "2026-11-03T10:00:04Z", messages=same),
        row(
            4,
            "2026-11-03T10:00:05Z",
            "2026-11-03T10:00:06Z",
            messages=same + [{"role": "assistant", "content": "x"}],
        ),
    ]
    merge_proxy_spans(paths, records, "t_1")
    chats = [s for s in read_jsonl(paths.trace) if s["name"].startswith("chat ")]
    assert [attrs(c)["evals.attempt"] for c in chats] == [1, 2, 3, 1]
    assert [c["status"]["code"] for c in chats] == [2, 2, 1, 1]
    usage = ProxyClient.usage(records)
    assert usage["model_calls"] == 4 and usage["failed_calls"] == 2
    assert usage["attempts"] == 4 and usage["retried_calls"] == 0
    assert usage["last_status"] == "200"


def test_litellm_retries_are_attempts_not_calls(tmp_path):
    """D16: LiteLLM retries inside one request, which stays one row (seen 4 Nov on v1.99.4:
    429, 429, 200 from the fake gave one success row with attempted_retries 2). So the trace
    shows 1 harness request with 3 provider attempts, not a harness retry."""
    paths, _ = make_trace(tmp_path, [(ns("2026-11-03T10:00:00Z"), ns("2026-11-03T10:01:00Z"))])
    same = [{"role": "user", "content": "same"}]
    budget = row(3, "2026-11-03T10:00:09Z", "2026-11-03T10:00:09Z", "failure", "429", same)
    budget["metadata"]["attempted_retries"] = budget["metadata"]["max_retries"] = None
    budget["metadata"]["error_information"]["error_budget_limit"] = "1e-06"
    records = [
        row(1, "2026-11-03T10:00:01Z", "2026-11-03T10:00:04Z", messages=same, retries=2),
        row(2, "2026-11-03T10:00:05Z", "2026-11-03T10:00:15Z", "failure", "503", retries=3),
        budget,
    ]
    merge_proxy_spans(paths, records, "t_1")
    chats = [s for s in read_jsonl(paths.trace) if s["name"].startswith("chat ")]
    assert [attrs(c)["evals.proxy.attempts"] for c in chats] == [3, 4, 0]
    assert [attrs(c)["evals.attempt"] for c in chats] == [1, 1, 1]  # the harness sent each once
    usage = ProxyClient.usage(records)
    assert usage["model_calls"] == 3
    assert usage["attempts"] == 7 and usage["retried_calls"] == 2
    assert usage["failed_calls"] == 2 and usage["last_status"] == "budget_exceeded"
    report = json.loads((CONTRACT / "examples" / "runner-report.json").read_text())
    report["proxy_usage"] = usage
    assert errors("runner-report", report) == []


def test_status_and_labels():
    assert call_status(row(1, "a", "b")) == "200"
    assert call_status(row(1, "a", "b", "failure", "429")) == "429"
    budget = row(1, "a", "b", "failure", "400")
    budget["metadata"]["error_information"]["error_budget_limit"] = "0.5"
    assert call_status(budget) == "budget_exceeded"
    ok = {"signal": None, "exit_code": 0}
    harness_error = {"result": {"end_state": "harness_error"}}
    assert label(ok, harness_error, {"last_status": "429"}) == "infra:provider_error"
    assert label(ok, harness_error, {"last_status": "503"}) == "infra:provider_error"
    assert label(ok, harness_error, {"last_status": "budget_exceeded"}) == "infra:budget_net"
    assert label(ok, harness_error, {"last_status": "200"}) == "agent"
    assert label(ok, harness_error, None) == "agent"
    assert label(ok, {"result": None}, None) == "infra:adapter_crash"
    assert (
        label({"signal": "SIGKILL", "exit_code": None}, {"result": None}, None)
        == "infra:timeout_kill"
    )


def test_runner_waits_for_lagging_spend_logs():
    """LiteLLM can lag by seconds; the runner must wait for at least the harness's count."""
    client = ProxyClient("http://unused", "sk-unused")
    polls = {"n": 0}

    def lagging(method, path, body=None):
        polls["n"] += 1
        return [] if polls["n"] < 8 else [row(1, "a", "b"), row(2, "c", "d")]

    client._request = lagging
    rows, complete = client.call_records("tok", expect_at_least=2, settle_s=0.1, min_wait_s=0.1)
    assert len(rows) == 2 and complete
    assert polls["n"] >= 8


def test_runner_flags_spend_logs_that_never_catch_up():
    client = ProxyClient("http://unused", "sk-unused")
    client._request = lambda method, path, body=None: [row(1, "a", "b")]
    rows, complete = client.call_records(
        "tok", expect_at_least=3, settle_s=0.1, min_wait_s=0.1, max_wait_s=0.5
    )
    assert len(rows) == 1 and not complete
    assert ProxyClient.usage(rows, complete)["complete"] is False


def stub(client: ProxyClient, rows_for):
    """`rows_for(token, seconds since the stub was made)` answers each spend-log read."""
    t0 = time.time()
    reads: list[tuple[str, float]] = []

    def request(method, path, body=None):
        token = path.split("api_key=")[1]
        reads.append((token, time.time() - t0))
        return rows_for(token, time.time() - t0)

    client._request = request
    return reads


def test_both_keys_are_read_until_each_holds_what_the_trial_made():
    """Soak test (6 Nov): the simulator key had no floor. Each key now waits for its own."""
    client = ProxyClient("http://unused", "sk-unused")
    stub(
        client,
        lambda tok, t: [
            row(i, "a", "b") for i in range(2 if tok == "agent" else (3 if t > 0.6 else 1))
        ],
    )
    rows, complete = client.read_calls([("agent", 2), ("sim", 3)], quiet_s=0.2, settle_s=0.2)
    assert complete and len(rows["agent"]) == 2 and len(rows["sim"]) == 3


def test_a_key_short_of_its_floor_leaves_the_whole_record_incomplete():
    client = ProxyClient("http://unused", "sk-unused")
    stub(client, lambda tok, t: [row(i, "a", "b") for i in range(2)])
    rows, complete = client.read_calls(
        [("agent", 2), ("sim", 3)], quiet_s=0.1, settle_s=0.1, max_wait_s=0.6
    )
    assert not complete and len(rows["sim"]) == 2


def test_a_row_that_lands_within_the_quiet_period_is_kept_and_none_is_read_before_it_could_count():
    """A call nobody counted (Hermes's summary call) lands after the floor is met: the record is
    only complete once LiteLLM's last batch since the adapter exited is written."""
    client = ProxyClient("http://unused", "sk-unused")
    since = time.time()
    reads = stub(client, lambda tok, t: [row(i, "a", "b") for i in range(3 if t > 0.8 else 2)])
    rows, complete = client.read_calls([("agent", 2)], since=since, quiet_s=1.2, settle_s=0.3)
    assert complete and len(rows["agent"]) == 3
    assert time.time() - since >= 1.2
    # The first read waits until since + quiet_s - settle_s: nothing earlier could show it.
    assert reads[0][1] >= 0.85


def test_a_log_still_changing_when_the_wait_runs_out_is_not_complete():
    client = ProxyClient("http://unused", "sk-unused")
    stub(client, lambda tok, t: [row(i, "a", "b") for i in range(int(t * 10))])
    _rows, complete = client.read_calls([("agent", 1)], quiet_s=0.1, settle_s=0.3, max_wait_s=0.8)
    assert not complete


def test_the_quiet_period_covers_litellms_longest_flush_and_its_write():
    """LiteLLM v1.99.4 flushes its spend log every proxy_batch_write_at + randint(0, 5) s, drawn at
    start-up; compose sets proxy_batch_write_at to 1 (services/litellm/config.yaml)."""
    text = (REPO / "services" / "litellm" / "config.yaml").read_text()
    (batch,) = re.findall(r"^\s*proxy_batch_write_at:\s*(\d+)\s*$", text, re.MULTILINE)
    assert int(batch) + 5 + 1 <= SPEND_LOG_QUIET_S


def test_the_simulator_floor_is_one_call_per_reply_line(tmp_path):
    paths = TrialPaths(tmp_path)
    assert _sim_calls(paths) == 0
    paths.out.mkdir(parents=True)
    paths.sim_replies.write_text('{"key": "a"}\n{"key": "b", "error": "empty"}\nnot json\n\n[1]\n')
    assert _sim_calls(paths) == 2
