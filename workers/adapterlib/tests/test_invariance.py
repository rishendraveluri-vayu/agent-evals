# ruff: noqa: E501
"""The invariance diff on stored first requests."""

import json

from evals_adapter.invariance import diff_trials, report

SYSTEM = (
    "You are Hermes Agent.\n"
    "Task prompt v1: be kind.\n"
    "Conversation started: Tuesday, November 03, 2026 (UTC)\n"
    "Current working directory: {root}/home\n"
)


def trial(
    tmp_path, name, prompt="Task prompt v1: be kind.", temperature=0.2, tools=("calculate_emi",)
):
    root = tmp_path / name / "trial"
    proxy = root / "out" / "artifacts" / "proxy"
    proxy.mkdir(parents=True)
    body = {
        "model": "fake/finance-emi",
        "temperature": temperature,
        "messages": [
            {
                "role": "system",
                "content": SYSTEM.format(root=root).replace("Task prompt v1: be kind.", prompt),
            },
            {"role": "user", "content": "What is my EMI?"},
        ],
        "tools": [{"type": "function", "function": {"name": n}} for n in tools],
        "_headers_seen": ["host"],
    }
    (proxy / "0001.request.json").write_text(json.dumps(body))
    return root


def test_same_config_in_different_folders_and_days_is_identical(tmp_path):
    a = trial(tmp_path, "a")
    b = trial(tmp_path, "b")
    b_req = b / "out" / "artifacts" / "proxy" / "0001.request.json"
    b_req.write_text(b_req.read_text().replace("Tuesday, November 03", "Wednesday, November 04"))
    assert diff_trials(a, b, "none") == []


def test_prompt_axis_shows_only_the_changed_line(tmp_path):
    a = trial(tmp_path, "a")
    b = trial(tmp_path, "b", prompt="Task prompt v2: be kind and ask first.")
    diffs = diff_trials(a, b, "system_prompt")
    assert [d.path for d in diffs] == ["messages[0].content"]
    assert diffs[0].on_axis
    assert diffs[0].lines == [
        "-Task prompt v1: be kind.",
        "+Task prompt v2: be kind and ask first.",
    ]


def test_a_change_off_the_axis_is_unexpected(tmp_path):
    a = trial(tmp_path, "a")
    b = trial(
        tmp_path,
        "b",
        prompt="Task prompt v2.",
        temperature=0.7,
        tools=("calculate_emi", "list_debts"),
    )
    diffs = diff_trials(a, b, "system_prompt")
    unexpected = sorted(d.path for d in diffs if not d.on_axis)
    assert unexpected == ["temperature", "tools[1]"]
    assert "UNEXPECTED" in report(diffs)
