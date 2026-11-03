"""Merging LiteLLM's spend-log rows into the trace. Row shapes copied from LiteLLM v1.99.4
(checked 3 Nov against the compose proxy and the fake model)."""

import json

from evals_adapter.proxy import ProxyClient, call_status, merge_proxy_spans
from evals_adapter.runner import label
from evals_adapter.spec import TrialPaths
from evals_adapter.trace import Tracer, trace_id_for
from support import attrs, errors, read_jsonl


def row(n, start, end, status="success", code=None, messages=None, spend=0.000034):
    meta = {"error_information": None}
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
    assert usage["last_status"] == "200"


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
