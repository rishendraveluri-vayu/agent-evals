"""The library end to end through the runner, with a scripted adapter and no model."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest
from evals_adapter import runner
from evals_adapter.runner import TrialInputs, run_trial
from support import (
    SCRIPTED_CMD,
    SimServer,
    attrs,
    client_sim,
    errors,
    make_spec,
    read_jsonl,
)

KEY_ENV = {"EVALS_MODEL_API_KEY": "sk-test-not-a-key"}


def run(tmp_path: Path, spec: dict, **kw) -> tuple[dict, dict, list[dict]]:
    trial_dir = tmp_path / "trial"
    env = dict(KEY_ENV)
    env.update(kw.pop("env", {}))
    report = run_trial(trial_dir, TrialInputs(spec=spec, adapter_cmd=SCRIPTED_CMD, env=env, **kw))
    out = trial_dir / "out"
    result = json.loads((out / "result.json").read_text()) if (out / "result.json").exists() else {}
    spans = read_jsonl(out / "trace.jsonl") if (out / "trace.jsonl").exists() else []
    return report, result, spans


def by_name(spans: list[dict], prefix: str) -> list[dict]:
    return [s for s in spans if s["name"].startswith(prefix)]


def test_single_turn_answer_is_valid_and_traced(tmp_path):
    report, result, spans = run(tmp_path, make_spec())
    assert report["label"] == "agent", report
    assert errors("runner-report", report) == []
    assert errors("result", result) == []
    for span in spans:
        assert errors("span", span) == [], span
    assert result["end_state"] == "answered"
    assert result["final_answer"] == "Your EMI is Rs 8,997.26."
    assert result["conversation"] == {
        "agent_turns": 1,
        "client_turns": 0,
        "ended_by": None,
        "transcript": [
            {
                "role": "user",
                "content": "What is my EMI on Rs 10 lakh at 9% for 20 years?",
                "source": "task",
            },
            {"role": "assistant", "content": "Your EMI is Rs 8,997.26.", "source": "agent"},
        ],
    }
    assert result["counts"] == {
        "model_calls": 2,
        "tool_calls": 1,
        "tool_errors": 0,
        "malformed_tool_calls": 0,
    }
    assert result["harness_usage"] == {
        "model_calls": 2,
        "input_tokens": 10,
        "output_tokens": 5,
        "cost_usd": None,
    }

    root = [s for s in spans if "parentSpanId" not in s]
    assert len(root) == 1 and root[0]["name"] == "invoke_agent scripted"
    assert attrs(root[0])["evals.end_state"] == "answered"
    assert attrs(root[0])["evals.trial.id"] == "t_test_0001"
    (turn,) = by_name(spans, "agent.turn")
    (tool,) = by_name(spans, "execute_tool")
    assert turn["parentSpanId"] == root[0]["spanId"]
    assert tool["parentSpanId"] == turn["spanId"]
    assert attrs(tool)["gen_ai.tool.name"] == "calculate_emi"
    assert {s["traceId"] for s in spans} == {root[0]["traceId"]}


def test_applied_settings_show_sources_and_harness_defaults(tmp_path):
    _, result, _ = run(tmp_path, make_spec())
    applied = result["applied_settings"]
    assert applied["temperature"] == {"value": 0.2, "source": "config"}
    assert applied["max_steps"] == {"value": 15, "source": "platform_default"}
    assert applied["parallel_tool_calls"] == {
        "value": None,
        "source": "unsupported",
        "observed": "always parallel",
    }
    assert applied["top_p"] == {"value": 1.0, "source": "harness_default"}


def test_setting_the_harness_cannot_take_is_refused(tmp_path):
    spec = make_spec(
        **{"settings.parallel_tool_calls": False, "settings_sources.parallel_tool_calls": "config"}
    )
    report, result, _ = run(tmp_path, spec)
    assert result["end_state"] == "harness_error"
    assert "parallel_tool_calls is not supported" in result["end_detail"]["exception_message"]
    assert report["adapter"]["exit_code"] == 0


def test_timeout_writes_a_result_and_closes_open_spans(tmp_path):
    spec = make_spec(
        **{"settings.timeout_s": 1.5, "harness_options.turns": [{"sleep_s": 30, "reply": "late"}]}
    )
    started = time.time()
    report, result, spans = run(tmp_path, spec)
    assert time.time() - started < 8
    assert report["label"] == "agent"
    assert result["end_state"] == "timeout"
    assert result["end_detail"]["harness_stop_reason"] == "adapter_timeout"
    (slow,) = by_name(spans, "execute_tool slow_tool")
    assert slow["status"]["code"] == 2
    root = [s for s in spans if "parentSpanId" not in s][0]
    assert root["status"]["code"] == 2
    assert errors("result", result) == []


def test_safety_net_kills_an_adapter_that_ignores_its_timeout(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "safety_net_s", lambda t: 1.0)
    trial_dir = tmp_path / "trial"
    report = run_trial(
        trial_dir,
        TrialInputs(spec=make_spec(), adapter_cmd=["sleep", "30"], env=dict(KEY_ENV)),
    )
    assert report["label"] == "infra:timeout_kill"
    assert report["adapter"]["signal"] == "SIGKILL"
    assert report["end_state"] is None


def test_crash_before_result_is_infra_and_keeps_logs(tmp_path):
    spec = make_spec(**{"harness_options.crash_before_lib": 7})
    report, result, _ = run(tmp_path, spec)
    assert report["label"] == "infra:adapter_crash"
    assert report["adapter"]["exit_code"] == 7
    assert result == {}
    stderr = (tmp_path / "trial" / "out" / "stderr.log").read_text()
    assert "crashing on purpose" in stderr
    assert report["logs"]["stderr"]["bytes"] == len(stderr.encode())


def test_exception_in_run_turn_is_harness_error_with_detail(tmp_path):
    spec = make_spec(**{"harness_options.turns": [{"raise": "boom"}]})
    report, result, _ = run(tmp_path, spec)
    assert report["adapter"]["exit_code"] == 0
    assert result["end_state"] == "harness_error"
    assert result["end_detail"]["exception_type"] == "RuntimeError"
    assert result["end_detail"]["exception_message"] == "boom"
    assert result["final_answer"] is None


def test_tool_errors_and_malformed_calls_are_counted(tmp_path):
    turns = [
        {
            "reply": "done",
            "tools": [
                {
                    "name": "calculate_emi",
                    "result": "bad rate",
                    "is_error": True,
                    "kind": "tool_error",
                },
                {
                    "name": "calculate_emi",
                    "result": "invalid JSON",
                    "is_error": True,
                    "kind": "malformed_tool_call",
                },
            ],
        }
    ]
    _, result, spans = run(tmp_path, make_spec(**{"harness_options.turns": turns}))
    assert result["counts"]["tool_errors"] == 2
    assert result["counts"]["malformed_tool_calls"] == 1
    (turn,) = by_name(spans, "agent.turn")
    assert [e["name"] for e in turn["events"]] == ["evals.error"]


def test_integrity_hash_catches_a_harness_editing_its_own_config(tmp_path):
    spec = make_spec(**{"harness_options.turns": [{"reply": "ok", "tamper": True}]})
    _, result, _ = run(tmp_path, spec)
    before, after = result["integrity"]["before"], result["integrity"]["after"]
    assert before.keys() == after.keys() == {"config.txt"}
    assert before["config.txt"] != after["config.txt"]


def test_leftover_processes_are_swept(tmp_path):
    spec = make_spec(**{"harness_options.spawn_orphan": True})
    report, result, _ = run(tmp_path, spec)
    assert result["end_state"] == "answered"
    assert report["adapter"]["leftover_processes"] >= 1
    tag_hits = [
        p
        for p in os.listdir("/proc")
        if p.isdigit() and _cmd(p) == "sleep 300" and _in_trial(p, tmp_path)
    ]
    assert tag_hits == []


def _cmd(pid: str) -> str:
    try:
        return Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode().strip()
    except OSError:
        return ""


def _in_trial(pid: str, tmp_path: Path) -> bool:
    try:
        return str(tmp_path).encode() in Path(f"/proc/{pid}/environ").read_bytes()
    except OSError:
        return False


def test_trial_folder_is_never_reused(tmp_path):
    trial_dir = tmp_path / "trial"
    run_trial(trial_dir, TrialInputs(spec=make_spec(), adapter_cmd=SCRIPTED_CMD, env=dict(KEY_ENV)))
    with pytest.raises(RuntimeError, match="not empty"):
        run_trial(
            trial_dir, TrialInputs(spec=make_spec(), adapter_cmd=SCRIPTED_CMD, env=dict(KEY_ENV))
        )


def test_spec_is_read_only_and_keys_reach_only_the_adapter(tmp_path):
    report, _, _ = run(tmp_path, make_spec())
    spec_file = tmp_path / "trial" / "spec.json"
    assert not os.access(spec_file, os.W_OK) or os.geteuid() == 0
    assert "sk-test-not-a-key" not in spec_file.read_text()
    for f in report["files"]:
        assert "sk-test-not-a-key" not in (tmp_path / "trial" / "out" / f["path"]).read_text(
            errors="ignore"
        )


def test_step_budget_spans_the_whole_conversation(tmp_path):
    sim = SimServer(["Tell me more.", "And then?", "Thanks."])
    try:
        turns = [{"reply": "{{last_user}}", "model_calls": 2, "echo_max_steps": True}]
        spec = make_spec(
            **{
                "settings.max_steps": 5,
                "harness_options.turns": turns,
                "task.client_sim": client_sim(sim.url, max_turns=3),
            }
        )
        _, result, _ = run(tmp_path, spec, env={"EVALS_SIM_API_KEY": "sk-sim"})
    finally:
        sim.close()
    # Each turn gets what is left of the trial's budget (D17: steps count across turns).
    assert result["harness"]["extra"]["max_steps_seen"] == [5, 3, 1]
    # The client asked again after the budget was spent, so the trial ends at the step limit.
    assert result["end_state"] == "step_limit"
    assert result["conversation"]["ended_by"] == "agent_end_state"
    assert result["conversation"]["agent_turns"] == 3


def test_simulated_conversation_runs_and_caches_client_replies(tmp_path):
    sim = SimServer(
        ["Will I lose the house?", "OK. What should I do first?", "Thank you. [[END_CONVERSATION]]"]
    )
    try:
        turns = [{"reply": "{{last_user}}", "model_calls": 1}]
        spec = make_spec(**{"harness_options.turns": turns, "task.client_sim": client_sim(sim.url)})
        spec["task"]["messages"] = [{"role": "user", "content": "I don't know where to start."}]
        report, result, spans = run(tmp_path / "a", spec, env={"EVALS_SIM_API_KEY": "sk-sim"})
        assert report["label"] == "agent"
        assert errors("result", result) == []
        conv = result["conversation"]
        assert conv["agent_turns"] == 3
        assert conv["client_turns"] == 3
        assert conv["ended_by"] == "client"
        assert [t["source"] for t in conv["transcript"]] == [
            "task",
            "agent",
            "client_sim",
            "agent",
            "client_sim",
            "agent",
            "client_sim",
        ]
        assert conv["transcript"][-1]["content"] == "Thank you."
        assert result["final_answer"] == "echo: OK. What should I do first?"
        sims = by_name(spans, "client_sim.turn")
        assert [attrs(s)["evals.sim.cache_hit"] for s in sims] == [False, False, False]
        # The simulator sees the conversation from its side and nothing else.
        first = sim.requests[0]["body"]
        assert first["messages"][0]["role"] == "system"
        assert "Meera, 41, Pune" in first["messages"][0]["content"]
        assert [m["role"] for m in first["messages"][1:]] == ["assistant", "user"]
        assert first["temperature"] == 0 and first["max_tokens"] == 300
        assert sim.requests[0]["auth"] == "Bearer sk-sim"

        replies = read_jsonl(tmp_path / "a" / "trial" / "out" / "sim_replies.jsonl")
        cache = {r["key"]: r["reply"] for r in replies}
        calls_before = len(sim.requests)
        _, result2, spans2 = run(
            tmp_path / "b", spec, env={"EVALS_SIM_API_KEY": "sk-sim"}, sim_cache=cache
        )
        assert len(sim.requests) == calls_before
        assert [attrs(s)["evals.sim.cache_hit"] for s in by_name(spans2, "client_sim.turn")] == [
            True
        ] * 3
        assert result2["conversation"]["transcript"] == conv["transcript"]
    finally:
        sim.close()


def test_conversation_stops_at_the_turn_cap(tmp_path):
    sim = SimServer(["More?"])
    try:
        spec = make_spec(
            **{
                "harness_options.turns": [{"reply": "ok"}],
                "task.client_sim": client_sim(sim.url, 2),
            }
        )
        _, result, _ = run(tmp_path, spec, env={"EVALS_SIM_API_KEY": "sk-sim"})
    finally:
        sim.close()
    assert result["conversation"]["ended_by"] == "turn_cap"
    assert result["conversation"]["client_turns"] == 2
    assert result["conversation"]["agent_turns"] == 3


def test_agent_failure_mid_conversation_ends_it(tmp_path):
    sim = SimServer(["More?"])
    try:
        turns = [
            {"reply": "first"},
            {"stop": "step_limit", "reply": None, "reason": "max_iterations"},
        ]
        spec = make_spec(**{"harness_options.turns": turns, "task.client_sim": client_sim(sim.url)})
        _, result, _ = run(tmp_path, spec, env={"EVALS_SIM_API_KEY": "sk-sim"})
    finally:
        sim.close()
    assert result["end_state"] == "step_limit"
    assert result["conversation"]["ended_by"] == "agent_end_state"
    assert result["final_answer"] == "first"


def test_simulator_failure_is_harness_error(tmp_path):
    spec = make_spec(**{"task.client_sim": client_sim("http://127.0.0.1:9/v1")})
    _, result, _ = run(tmp_path, spec, env={"EVALS_SIM_API_KEY": "sk-sim"})
    assert result["end_state"] == "harness_error"
    assert result["end_detail"]["harness_stop_reason"] == "simulator_error"
