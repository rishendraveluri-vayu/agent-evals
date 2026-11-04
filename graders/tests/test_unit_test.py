"""The unit_test grader: a task's grade(trial) in a subprocess with a timeout and no network."""

from __future__ import annotations

import textwrap
import time

import pytest
from support import EMI_ARGS, EMI_RESULT, make_trial, real

from evals_graders.canonical import spec_sha256
from evals_graders.graders import grade_trial
from evals_graders.unit import normalise_result

PASSING = """
def grade(trial):
    emi = [c for c in trial["tool_calls"] if c["name"] == "calculate_emi"]
    if not emi:
        return {"pass": False, "reason": "no EMI calculation"}
    said = "8,997" in (trial["final_answer"] or "")
    call = emi[0]
    ev = [{"source": "tool_result", "span_id": call["span_id"], "quote": call["result_text"][:40]}]
    verdict = "pass" if said else "fail"
    return {"verdict": verdict, "reason": "EMI stated" if said else "EMI missing", "evidence": ev}
"""


def task(tmp_path, code, name="grader.py"):
    d = tmp_path / "task"
    d.mkdir(exist_ok=True)
    (d / name).write_text(textwrap.dedent(code), encoding="utf-8")
    return d


def run(
    tmp_path,
    code,
    answer="Your EMI is ₹8,997.",
    spec=None,
    tools=(("calculate_emi", EMI_ARGS, EMI_RESULT),),
):
    out = make_trial(tmp_path / "trial", answer, list(tools))
    spec = {"id": "u", "type": "unit_test", **(spec or {})}
    return grade_trial(out, [spec], task_dir=task(tmp_path, code))["grades"][0]


def test_pass_and_fail(tmp_path):
    g = run(tmp_path, PASSING)
    assert g["verdict"] == "pass" and g["score"] == 1.0 and g["reason"] == "EMI stated"
    assert (
        g["evidence"][0]["source"] == "tool_result"
        and g["evidence"][0]["span_id"] == "0000000000000001"
    )
    g = run(tmp_path, PASSING, answer="Your EMI is about ₹9,000.")
    assert g["verdict"] == "fail" and g["score"] == 0.0
    g = run(tmp_path, PASSING, tools=())
    assert g["verdict"] == "fail" and g["reason"] == "no EMI calculation"


def test_a_grader_that_hangs_is_killed_at_its_timeout(tmp_path):
    started = time.monotonic()
    g = run(tmp_path, "import time\ndef grade(trial):\n    time.sleep(30)\n", spec={"timeout_s": 1})
    took = time.monotonic() - started
    assert g["verdict"] == "error" and g["score"] is None
    assert "timed out after 1 s" in g["reason"]
    assert took < 10


def test_a_grader_that_raises_is_an_error_not_a_fail(tmp_path):
    g = run(tmp_path, "def grade(trial):\n    raise ValueError('bad fixture')\n")
    assert g["verdict"] == "error" and "ValueError: bad fixture" in g["reason"]


@pytest.mark.parametrize(
    ("code", "words"),
    [
        ("def grade(trial):\n    return 'pass'\n", "must return a dict"),
        ("def grade(trial):\n    return {'score': 0.5}\n", "no usable verdict"),
        ("def grade(trial):\n    return {'verdict': 'pass', 'score': 3}\n", "from 0 to 1"),
        ("def other(trial):\n    return {}\n", "has no function grade"),
        ("def grade(:\n", "SyntaxError"),
    ],
)
def test_unusable_graders_are_errors(tmp_path, code, words):
    g = run(tmp_path, code)
    assert g["verdict"] == "error" and words in g["reason"], g["reason"]


def test_no_network(tmp_path):
    code = """
    import socket
    def grade(trial):
        socket.create_connection(("127.0.0.1", 9), timeout=1)
        return {"pass": True}
    """
    g = run(tmp_path, code)
    assert g["verdict"] == "error" and "may not use the network" in g["reason"]


def test_no_child_processes(tmp_path):
    code = """
    import subprocess
    def grade(trial):
        subprocess.run(["curl", "http://example.com"])
        return {"pass": True}
    """
    g = run(tmp_path, code)
    assert g["verdict"] == "error" and "start processes" in g["reason"]


def test_function_and_file_options_and_a_missing_file(tmp_path):
    code = "def check(trial):\n    return {'verdict': 'pass', 'score': 0.75, 'reason': 'custom'}\n"
    out = make_trial(tmp_path / "trial", "x")
    d = task(tmp_path, code, name="checks_emi.py")
    g = grade_trial(
        out,
        [{"id": "u", "type": "unit_test", "file": "checks_emi.py", "function": "check"}],
        task_dir=d,
    )["grades"][0]
    assert (g["verdict"], g["score"], g["reason"]) == ("pass", 0.75, "custom")
    g = grade_trial(out, [{"id": "u", "type": "unit_test"}], task_dir=d)["grades"][0]
    assert g["verdict"] == "error" and "grader.py is not next to task.json" in g["reason"]


def test_the_version_covers_the_grader_file(tmp_path):
    out = make_trial(tmp_path / "trial", "x")
    d = task(tmp_path, "def grade(trial):\n    return {'pass': True}\n")
    spec = {"id": "u", "type": "unit_test"}
    first = grade_trial(out, [spec], task_dir=d)["grades"][0]
    (d / "grader.py").write_text("def grade(trial):\n    return {'pass': False}\n")
    second = grade_trial(out, [spec], task_dir=d)["grades"][0]
    assert first["grader_version"] != second["grader_version"]
    assert first["spec_sha256"] != spec_sha256(spec)  # the file's hash is part of it


def test_on_a_real_trial(tmp_path):
    """A unit test over the Hermes trial: the plan's months appear in the answer."""
    code = """
    import re
    def grade(trial):
        plan = [c for c in trial["tool_calls"] if c["name"] == "debt_payoff_plan"][-1]
        months = plan["result"]["months_to_debt_free"]
        m = re.search(rf"\\b{months} months\\b", trial["final_answer"])
        return {"pass": bool(m), "evidence": [m.group(0)] if m else []}
    """
    g = grade_trial(
        real("hermes-single"), [{"id": "u", "type": "unit_test"}], task_dir=task(tmp_path, code)
    )["grades"][0]
    assert g["verdict"] == "pass"
    assert g["evidence"] == [{"source": "final_answer", "quote": "28 months"}]


def test_normalise_result():
    assert normalise_result({"passed": True})["verdict"] == "pass"
    assert normalise_result({"verdict": "not_applicable"})["score"] is None
    assert (
        normalise_result({"pass": True, "evidence": [{"source": "nowhere", "quote": "x"}]})[
            "verdict"
        ]
        == "error"
    )
