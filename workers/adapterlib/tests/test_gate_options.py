"""Gate options a harness declares, checked on stored runs (no model, no servers)."""

from pathlib import Path

import pytest

from evals_adapter.gate import Gate, GateRun

VALID = {"result_valid": True, "result_errors": [], "trace_valid": True, "trace_errors": []}


def _request(*messages: dict) -> dict:
    return {"script": "finance-malformed", "body": {"messages": list(messages)}}


def _run(trial_dir: Path, recovered: bool) -> GateRun:
    """A finance-malformed run: either the error went back and the model recovered, or the
    harness ended the run at the malformed call."""
    (trial_dir / "out").mkdir(parents=True, exist_ok=True)
    (trial_dir / "out" / "stderr.log").write_text("")
    user = {"role": "user", "content": "EMI?"}
    if recovered:
        error = {"role": "tool", "tool_call_id": "c1", "content": "Error: not valid JSON"}
        requests = [_request(user), _request(user, error), _request(user, error)]
        end_state, answer = "answered", "about Rs 8,997"
    else:
        requests, end_state, answer = [_request(user)], "agent_error", None
    result = {
        "end_state": end_state,
        "final_answer": answer,
        "counts": {"model_calls": len(requests), "malformed_tool_calls": 1},
    }
    return GateRun({"adapter": VALID}, result, [], requests, trial_dir, 0.1)


def _check(monkeypatch, tmp_path: Path, recovered: bool, **options) -> None:
    run = _run(tmp_path / "trial", recovered)
    gate = Gate(harness="h", adapter_cmd=["true"], capabilities={"settings": {}}, **options)
    monkeypatch.setattr(Gate, "spec", lambda self, *a, **k: {})
    monkeypatch.setattr(Gate, "run", lambda self, *a, **k: run)
    gate.test_malformed_tool_call(tmp_path, None)


def test_by_default_the_malformed_error_must_reach_the_model(monkeypatch, tmp_path):
    _check(monkeypatch, tmp_path, recovered=True)
    with pytest.raises(AssertionError):
        _check(monkeypatch, tmp_path, recovered=False)


def test_a_declared_end_state_accepts_only_a_labelled_unanswered_end(monkeypatch, tmp_path):
    _check(monkeypatch, tmp_path, recovered=False, malformed_ends_in="agent_error")
    with pytest.raises(AssertionError):  # an answer the harness could not have reached
        _check(monkeypatch, tmp_path, recovered=True, malformed_ends_in="agent_error")
    with pytest.raises(AssertionError):  # the wrong label
        _check(monkeypatch, tmp_path, recovered=False, malformed_ends_in="harness_error")


def test_the_gate_tool_test_expects_toolset_v3s_19_tools():
    """Every harness's gate test_tools compares what reaches the model with the finance server's
    manifest snapshot, so since D58 it expects 19 tools, reference_rates last (toolset v3)."""
    from evals_adapter.gate import ALL_FINANCE_TOOLS

    assert len(ALL_FINANCE_TOOLS) == 19
    assert ALL_FINANCE_TOOLS[11:] == [
        "add",
        "subtract",
        "multiply",
        "divide",
        "percent_of",
        "percent_change",
        "round",
        "reference_rates",
    ]
