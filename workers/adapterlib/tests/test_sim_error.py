"""An empty or failed simulator turn is a simulator failure, never the client ending (D26).

On 4 Nov Claude Haiku 5.5 spent the simulator's whole 300-token cap on reasoning and returned an
empty reply; the library took that as the client ending, so three conversations stopped after
one agent turn and were graded as the agent's. Now such a turn ends the conversation with
ended_by sim_error and the runner labels the trial infra:sim_error. The simulated client here
is the fake model server (services/fake-llm): `sim-empty` replies with no text, `sim-client`
replies twice and then ends with the marker.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from support import SCRIPTED_CMD, SimServer, attrs, client_sim, errors, make_spec, read_jsonl

from evals_adapter.gate import FAKE_DIR, FakeServer
from evals_adapter.runner import TrialInputs, run_trial
from evals_adapter.sim import END_MARKER, empty_reply

KEYS = {"EVALS_MODEL_API_KEY": "sk-test-not-a-key", "EVALS_SIM_API_KEY": "sk-sim"}
OPENING = "I don't know where to start."
ECHO = [{"reply": "{{last_user}}", "model_calls": 1}]


@pytest.fixture(scope="module")
def fake():
    if not (FAKE_DIR / ".venv" / "bin" / "fake-llm").exists():
        pytest.skip("run `uv sync` in services/fake-llm")
    server = FakeServer()
    yield server
    server.stop()


def sim_spec(base_url: str, sim_model: str = "fake/sim", max_turns: int = 3) -> dict:
    sim = client_sim(base_url, max_turns)
    sim["model"]["name"] = sim_model
    spec = make_spec(**{"harness_options.turns": ECHO, "task.client_sim": sim})
    spec["task"]["messages"] = [{"role": "user", "content": OPENING}]
    return spec


def run(tmp_path: Path, spec: dict, sim_cache: dict | None = None):
    trial = tmp_path / "trial"
    report = run_trial(
        trial, TrialInputs(spec=spec, adapter_cmd=SCRIPTED_CMD, env=dict(KEYS), sim_cache=sim_cache)
    )
    out = trial / "out"
    result = json.loads((out / "result.json").read_text())
    spans = read_jsonl(out / "trace.jsonl")
    replies_file = out / "sim_replies.jsonl"
    replies = read_jsonl(replies_file) if replies_file.exists() else []
    return report, result, spans, replies


def sim_turns(spans: list[dict]) -> list[dict]:
    return [s for s in spans if s["name"] == "client_sim.turn"]


def error_events(span: dict) -> list[dict]:
    return [attrs(e) for e in span.get("events", []) if e["name"] == "evals.error"]


def test_an_empty_simulator_reply_is_sim_error_not_a_client_ending(tmp_path, fake):
    fake.reset()
    report, result, spans, replies = run(tmp_path, sim_spec(fake.url, "fake/sim-empty"))

    assert report["label"] == "infra:sim_error", report
    assert errors("runner-report", report) == []
    assert errors("result", result) == []
    assert result["end_state"] == "harness_error"
    conv = result["conversation"]
    assert conv["ended_by"] == "sim_error"
    assert conv["agent_turns"] == 1 and conv["client_turns"] == 0
    assert [t["source"] for t in conv["transcript"]] == ["task", "agent"]
    # The agent's reply is still recorded; the trial is not graded because of its label.
    assert result["final_answer"] == "echo: " + OPENING
    detail = result["end_detail"]
    assert detail["harness_stop_reason"] == "simulator_error"
    assert detail["exception_type"] == "SimulatorError"
    assert detail["exception_message"].startswith("simulator reply has no text")
    assert "finish_reason stop" in detail["exception_message"]

    # The reason is also on the client_sim.turn span, which ends in error.
    [turn] = sim_turns(spans)
    assert turn["status"]["code"] == 2
    [event] = error_events(turn)
    assert event["evals.error.kind"] == "sim_empty_reply"
    assert event["evals.error.message"] == detail["exception_message"]
    assert attrs(turn)["evals.sim.cache_hit"] is False
    assert "evals.sim.message" not in attrs(turn)

    # The raw reply and its usage stay in sim_replies.jsonl, marked so it is never cached.
    [row] = replies
    assert row["reply"] == ""
    assert row["model"] == "fake/sim-empty"
    assert row["usage"]["completion_tokens"] == 0
    assert row["error"] == "reply has no text"
    assert row["key"] == attrs(turn)["evals.sim.cache_key"]
    assert [r["script"] for r in fake.requests()] == ["sim-empty"]


def test_a_cached_empty_reply_is_sim_error_too(tmp_path, fake):
    fake.reset()
    spec = sim_spec(fake.url, "fake/sim-empty")
    _, _, _, replies = run(tmp_path / "a", spec)
    fake.reset()
    cache = {replies[0]["key"]: ""}  # as an API from before this fix might hand out
    report, result, spans, again = run(tmp_path / "b", spec, sim_cache=cache)
    assert report["label"] == "infra:sim_error"
    assert result["conversation"]["ended_by"] == "sim_error"
    assert result["end_detail"]["exception_message"] == "cached simulator reply has no text"
    assert attrs(sim_turns(spans)[0])["evals.sim.cache_hit"] is True
    assert fake.requests() == [] and again == []


def test_a_normal_end_marker_still_ends_with_the_client(tmp_path, fake):
    fake.reset()
    report, result, spans, replies = run(tmp_path, sim_spec(fake.url, "fake/sim-client"))
    assert report["label"] == "agent", report
    assert result["end_state"] == "answered"
    conv = result["conversation"]
    assert conv["ended_by"] == "client"
    assert conv["agent_turns"] == 3 and conv["client_turns"] == 3
    assert conv["transcript"][-1] == {
        "role": "user",
        "content": "Thank you, that helps.",
        "source": "client_sim",
    }
    assert all(not error_events(s) for s in sim_turns(spans))
    assert len(replies) == 3 and not any("error" in r for r in replies)
    assert replies[-1]["reply"] == "Thank you, that helps. " + END_MARKER


def test_the_end_marker_alone_after_the_clients_goodbye_is_a_client_ending(tmp_path):
    sim = SimServer(["Thanks, that answers it. Bye.", END_MARKER])
    try:
        report, result, _, replies = run(tmp_path, sim_spec(sim.url))
    finally:
        sim.close()
    assert report["label"] == "agent", report
    conv = result["conversation"]
    assert conv["ended_by"] == "client"
    assert conv["client_turns"] == 1 and conv["agent_turns"] == 2
    assert conv["transcript"][-1]["content"] == "echo: Thanks, that answers it. Bye."
    assert [r.get("error") for r in replies] == [None, None]


def test_the_end_marker_alone_before_the_client_said_anything_is_sim_error(tmp_path):
    sim = SimServer([f"  {END_MARKER}  "])
    try:
        report, result, spans, replies = run(tmp_path, sim_spec(sim.url))
    finally:
        sim.close()
    assert report["label"] == "infra:sim_error"
    assert result["conversation"]["ended_by"] == "sim_error"
    assert result["conversation"]["client_turns"] == 0
    message = result["end_detail"]["exception_message"]
    assert "only the end marker, before the client has said anything" in message
    assert error_events(sim_turns(spans)[0])[0]["evals.error.kind"] == "sim_empty_reply"
    assert replies[0]["error"].startswith("reply holds only the end marker")


def test_an_empty_reply_later_in_the_conversation_is_sim_error(tmp_path):
    sim = SimServer(["Will I lose the house?", "   "])
    try:
        report, result, _, replies = run(tmp_path, sim_spec(sim.url))
    finally:
        sim.close()
    assert report["label"] == "infra:sim_error"
    conv = result["conversation"]
    assert conv["ended_by"] == "sim_error"
    assert conv["client_turns"] == 1 and conv["agent_turns"] == 2
    assert [r.get("error") for r in replies] == [None, "reply has no text"]


def test_a_failed_simulator_call_is_sim_error(tmp_path):
    report, result, spans, replies = run(tmp_path, sim_spec("http://127.0.0.1:9/v1"))
    assert report["label"] == "infra:sim_error"
    assert errors("result", result) == []
    assert result["end_state"] == "harness_error"
    assert result["conversation"]["ended_by"] == "sim_error"
    assert result["end_detail"]["harness_stop_reason"] == "simulator_error"
    assert result["end_detail"]["exception_message"].startswith("simulator call failed")
    [event] = error_events(sim_turns(spans)[0])
    assert event["evals.error.kind"] == "sim_call_failed"
    assert replies == []  # no reply to keep


@pytest.mark.parametrize(
    ("message", "done", "spoken", "problem"),
    [
        ("Will I lose the house?", False, False, None),
        ("Thanks, bye.", True, False, None),
        (None, True, True, None),
        (None, True, False, "reply holds only the end marker, before the client has said anything"),
        (None, False, False, "reply has no text"),
        (None, False, True, "reply has no text"),
    ],
)
def test_which_replies_are_empty(message, done, spoken, problem):
    assert empty_reply(message, done, spoken) == problem
