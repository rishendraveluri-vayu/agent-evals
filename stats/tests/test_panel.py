"""D71's panel comparison on hand-made rows and labels (synthetic data only)."""

from __future__ import annotations

import json

from evals_stats.panel import MAJORITY, disagreements, main, majority, pairs, summary, verdicts


def row(trial: str, model: str, criterion: str | None, verdict: str) -> dict:
    return {"trial_id": trial, "model": model, "criterion": criterion, "verdict": verdict}


ROWS = [
    row("t1", "a", "overall", "yes"),
    row("t1", "b", "overall", "yes"),
    row("t1", "c", "overall", "no"),
    row("t2", "a", "overall", "no"),
    row("t2", "b", "overall", "no"),
    row("t2", "c", "overall", "no"),
    row("t3", "a", "overall", "yes"),
    row("t3", "b", None, "error"),  # b's call on t3 failed
    row("t3", "c", "overall", "no"),
]
LABELS = {("t1", "overall"): "no", ("t2", "overall"): "no", ("t3", "overall"): "yes"}


def test_majority_needs_more_than_half():
    assert majority({"a": "yes", "b": "yes", "c": "no"}) == "yes"
    assert majority({"a": "yes", "b": "error", "c": "no"}) == "undecided"
    assert majority({"a": "no", "b": "no", "c": "unsure"}) == "no"


def test_a_failed_call_is_an_error_verdict_not_a_missing_judge():
    table = verdicts(ROWS)
    assert table[("t3", "overall")] == {"a": "yes", "b": "error", "c": "no"}


def test_pairs_put_each_judge_and_the_majority_against_the_label():
    table = verdicts(ROWS)
    assert [(p.trial_id, p.human, p.judge) for p in pairs(table, LABELS, "a")] == [
        ("t1", "no", "yes"),
        ("t2", "no", "no"),
        ("t3", "yes", "yes"),
    ]
    assert [p.judge for p in pairs(table, LABELS, MAJORITY)] == ["yes", "no", "undecided"]


def test_disagreements_list_judges_against_each_other_or_the_label():
    found = disagreements(verdicts(ROWS), LABELS)
    assert [d["trial_id"] for d in found] == ["t1", "t3"]  # t2: all no, label no
    assert found[0]["human"] == "no"


def test_summary_reports_each_judge_and_the_majority():
    out = summary(ROWS, LABELS, "exclude")
    assert list(out["judges"]) == ["a", "b", "c", MAJORITY]
    a = out["judges"]["a"][0]
    assert (a["tp"], a["fp"], a["fn"], a["tn"]) == (1, 1, 0, 1)
    assert out["judges"]["b"][0]["judge_undecided"] == 1


def test_cli_prints_tables_and_disagreements(tmp_path, capsys):
    panel = tmp_path / "panel.jsonl"
    panel.write_text("".join(json.dumps(r) + "\n" for r in ROWS))
    labels = tmp_path / "labels.jsonl"
    labels.write_text(
        "".join(
            json.dumps({"trial_id": t, "criterion": c, "value": v, "labelled_at": f"T0{i}"}) + "\n"
            for i, ((t, c), v) in enumerate(LABELS.items())
        )
    )
    assert main([str(panel), "--labels", str(labels)]) == 0
    out = capsys.readouterr().out
    assert "== majority" in out and "== disagreements (2)" in out
