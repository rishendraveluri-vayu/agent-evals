import json
import subprocess
import sys

from support import real

from evals_graders.cli import main


def write_task(tmp_path, graders):
    path = tmp_path / "task.json"
    path.write_text(json.dumps({"id": "t1", "graders": graders}), encoding="utf-8")
    return path


def test_prints_grades_as_json(tmp_path, capsys):
    task = write_task(
        tmp_path,
        [
            {
                "id": "interest",
                "type": "number",
                "expected": {"from_tool": "debt_payoff_plan", "field": "total_interest"},
            },
            {"id": "answered", "type": "end_state", "states": ["answered"]},
        ],
    )
    assert main([str(real("ownloop-single")), "--task", str(task)]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["task_id"] == "t1" and out["passed"] is True and out["outcome"] == "pass"
    assert [g["verdict"] for g in out["grades"]] == ["pass", "pass"]
    assert set(out["grades"][0]) == {
        "grader_id",
        "type",
        "required",
        "verdict",
        "score",
        "reason",
        "evidence",
        "grader_version",
        "spec_sha256",
    }


def test_bad_inputs_exit_2(tmp_path, capsys):
    assert main([str(real("ownloop-single")), "--task", str(tmp_path / "missing.json")]) == 2
    bad = tmp_path / "bad.json"
    bad.write_text('{"id": "x"}')
    assert main([str(real("ownloop-single")), "--task", str(bad)]) == 2
    task = write_task(tmp_path, [])
    assert main([str(tmp_path / "nowhere"), "--task", str(task)]) == 2


def test_the_console_script(tmp_path):
    task = write_task(tmp_path, [{"id": "a", "type": "end_state", "states": ["answered"]}])
    proc = subprocess.run(
        [
            sys.executable,
            "-m",
            "evals_graders.cli",
            str(real("hermes-settings")),
            "--task",
            str(task),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    out = json.loads(proc.stdout)
    assert (
        out["passed"] is False and out["grades"][0]["reason"] == "ended harness_error, not answered"
    )
