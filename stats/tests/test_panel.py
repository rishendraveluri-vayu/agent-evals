"""D71's panel comparison on hand-made rows and labels (synthetic data only)."""

from __future__ import annotations

import json

from evals_stats.panel import (
    HUMANS,
    MAJORITY,
    disagreements,
    main,
    majority,
    pairs,
    read_weights,
    summary,
    verdicts,
)


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


def test_a_criterion_one_judge_answered_has_no_majority_of_one():
    # m2 and m3 left criterion c out of their answers: m1's yes alone is not "two of three".
    rows = [
        row("t", "m1", "c", "yes"),
        row("t", "m1", "d", "yes"),
        row("t", "m2", "d", "no"),
        row("t", "m3", "d", "no"),
    ]
    table = verdicts(rows)
    assert table[("t", "c")] == {"m1": "yes", "m2": "missing", "m3": "missing"}
    assert majority(table[("t", "c")]) == "undecided"
    assert majority(table[("t", "d")]) == "no"


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
    out = summary(ROWS, {"rishi": LABELS}, "exclude")
    assert out["reference"] == "rishi" and list(out["references"]) == ["rishi"]
    assert out["between_raters"] == []
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
    assert "== against rishi (the reference that counts)" in out
    assert "  -- majority" in out
    assert "== disagreements with rishi or among judges (2)" in out


def test_with_two_raters_the_majority_counts_and_raters_are_compared():
    other = {("t1", "overall"): "no", ("t2", "overall"): "yes", ("t3", "overall"): "yes"}
    third = {("t1", "overall"): "no", ("t2", "overall"): "no", ("t3", "overall"): "unsure"}
    out = summary(ROWS, {"rishi": LABELS, "asha": other, "dev": third}, "exclude")
    assert out["reference"] == HUMANS
    assert list(out["references"]) == ["asha", "dev", "rishi", HUMANS]
    # The majority: t1 no (3 of 3), t2 no (2 of 3), t3 yes (2 firm answers, both yes).
    a = out["references"][HUMANS]["a"][0]
    assert (a["tp"], a["fp"], a["fn"], a["tn"]) == (1, 1, 0, 1)
    pairs_ = {tuple(b["raters"]): b for b in out["between_raters"]}
    assert pairs_[("asha", "rishi")]["n"] == 3 and pairs_[("asha", "rishi")]["agreement"] == 2 / 3
    assert pairs_[("dev", "rishi")]["n"] == 2  # dev was unsure on t3: left out


def test_weights_count_an_agreed_trial_for_the_ones_it_stands_for(tmp_path):
    f = tmp_path / "to-label.json"
    f.write_text(json.dumps({"disagreed": ["t1"], "agreed_drawn": ["t2"], "agreed_total": 4}))
    weights = read_weights(f)
    assert weights == {"t1": 1.0, "t2": 4.0}
    out = summary(ROWS, {"rishi": LABELS}, "exclude", weights=weights)
    t = out["weighted"]["rishi"]["a"]["overall"]
    # t1: judge yes, human no (FP, weight 1); t2: no/no (TN, weight 4); t3: yes/yes (TP, weight 1).
    assert (t["tp"], t["fp"], t["fn"], t["tn"]) == (1.0, 1.0, 0.0, 4.0)
