"""Every formula against a hand-worked example. All data here is SYNTHETIC: made-up verdicts to
check arithmetic, never labels (labels/ holds Rishi's own judgments only)."""

from __future__ import annotations

import json

import pytest

from evals_stats.agreement import (
    Pair,
    Table,
    bootstrap,
    corrected_rate,
    human_value,
    percentile,
    report,
    retest,
    rogan_gladen,
    self_agreement,
    table,
)
from evals_stats.agreement_cli import judge_verdicts, read_labels


def pairs_for(tp: int, fp: int, fn: int, tn: int, arm: str = "A", crit: str = "c") -> list[Pair]:
    out = []
    for kind, n, human, judge in (
        ("tp", tp, "yes", "yes"),
        ("fp", fp, "no", "yes"),
        ("fn", fn, "yes", "no"),
        ("tn", tn, "no", "no"),
    ):
        out += [Pair(f"{arm}-{kind}-{i}", crit, human, judge, arm) for i in range(n)]
    return out


def test_kappa_sensitivity_specificity_by_hand():
    # 20 tp, 5 fp, 10 fn, 15 tn: po = 35/50 = 0.7; judge yes 25/50, human yes 30/50;
    # pe = 0.5*0.6 + 0.5*0.4 = 0.5; kappa = (0.7 - 0.5) / 0.5 = 0.4.
    t = table(pairs_for(20, 5, 10, 15), "exclude")
    assert (t.tp, t.fp, t.fn, t.tn, t.n) == (20, 5, 10, 15, 50)
    assert t.agreement == pytest.approx(0.7)
    assert t.kappa == pytest.approx(0.4)
    assert t.sensitivity == pytest.approx(20 / 30)
    assert t.specificity == pytest.approx(15 / 20)
    assert t.false_pass_rate == pytest.approx(5 / 20)
    assert t.false_fail_rate == pytest.approx(10 / 30)


def test_kappa_is_undefined_when_both_raters_say_one_thing():
    assert Table(tp=10).kappa is None
    assert Table().kappa is None and Table().sensitivity is None
    assert Table(tp=5, fp=5).kappa == pytest.approx(0.0)  # judge always yes: no skill


def test_rishis_unsure_needs_an_explicit_policy():
    assert human_value("unsure", "exclude") is None
    assert human_value("unsure", "no") == "no"
    with pytest.raises(ValueError):
        human_value("unsure", "yes")


def test_unsure_and_judge_non_answers_are_counted_not_tabled():
    ps = pairs_for(3, 1, 1, 3) + [
        Pair("u1", "c", "unsure", "yes", "A"),
        Pair("j1", "c", "yes", "missing", "A"),
        Pair("j2", "c", "no", "unsure", "A"),
    ]
    [r] = report(ps, "exclude", resamples=50)
    assert r.table.n == 8 and r.human_left_out == 1 and r.judge_undecided == 2
    [r] = report(ps, "no", resamples=50)
    assert r.table.n == 9 and r.table.fp == 2  # unsure counted as Rishi's no


def test_percentile_matches_linear_interpolation():
    assert percentile([1, 2, 3, 4], 0.5) == 2.5
    assert percentile([5], 0.975) == 5
    assert percentile([0, 10], 0.25) == 2.5


def test_bootstrap_is_seeded_and_brackets_the_estimate():
    ps = pairs_for(20, 5, 10, 15)

    def kappa(s):
        return table(s, "exclude").kappa

    a = bootstrap(ps, kappa, resamples=500, seed=3)
    b = bootstrap(ps, kappa, resamples=500, seed=3)
    assert a == b and a.resamples == 500
    assert a.low < 0.4 < a.high
    assert bootstrap([], kappa).low is None


def test_per_arm_false_pass_gap():
    # arm A: false-pass rate 1/10; arm B: 5/10. Gap 0.4.
    ps = pairs_for(10, 1, 0, 9, arm="A") + pairs_for(10, 5, 0, 5, arm="B")
    [r] = report(ps, "exclude", resamples=300)
    assert r.by_arm["A"].false_pass_rate == pytest.approx(0.1)
    assert r.by_arm["B"].false_pass_rate == pytest.approx(0.5)
    assert r.false_pass_gap == pytest.approx(0.4)
    gi = r.false_pass_gap_interval
    assert gi is not None and gi.low <= 0.4 <= gi.high


def test_criteria_are_reported_separately():
    ps = pairs_for(5, 0, 0, 5, crit="tone") + pairs_for(5, 5, 0, 0, crit="numbers")
    by = {r.criterion: r for r in report(ps, "exclude", resamples=50)}
    assert by["tone"].table.kappa == pytest.approx(1.0)
    assert by["numbers"].table.specificity == 0.0


def test_rogan_gladen_by_hand():
    # judge passes 70%; Se 0.9, Sp 0.8: true = (0.7 + 0.8 - 1) / (0.9 + 0.8 - 1) = 0.5 / 0.7.
    assert rogan_gladen(0.7, 0.9, 0.8) == pytest.approx(0.5 / 0.7)
    assert rogan_gladen(0.1, 0.9, 0.8) == 0.0  # clipped
    assert rogan_gladen(0.5, 0.5, 0.5) is None  # a judge with no information


def test_corrected_rate_with_a_joint_bootstrap():
    labelled = pairs_for(18, 4, 2, 16)  # Se 0.9, Sp 0.8
    judged = [True] * 70 + [False] * 30
    out = corrected_rate(judged, labelled, "exclude", resamples=400, seed=1)
    assert out["judged_rate"] == pytest.approx(0.7)
    assert out["corrected_rate"] == pytest.approx(0.5 / 0.7)
    iv = out["interval"]
    assert iv["low"] < out["corrected_rate"] < iv["high"]
    assert out["labelled_pairs"] == 40 and out["judged_trials"] == 100


def test_retest_and_self_agreement():
    r = retest({"a": ["yes", "yes", "yes"], "b": ["yes", "no", "yes"], "c": ["no"]})
    assert r == {"items": 2, "stable": 1, "stable_share": 0.5, "single_run_items": 1}
    s = self_agreement(["yes", "no", "yes", "unsure"], ["yes", "no", "no", "yes"])
    assert s["n"] == 3 and s["agreement"] == pytest.approx(2 / 3) and s["left_out"] == 1


# ---- the CLI's readers -----------------------------------------------------------------------


def test_read_labels_keeps_the_first_and_sends_later_ones_to_self_agreement(tmp_path):
    lines = [
        {"trial_id": "t1", "criterion": "c", "value": "yes", "labelled_at": "2026-11-05T09:00Z"},
        {"trial_id": "t1", "criterion": "c", "value": "no", "labelled_at": "2026-11-06T09:00Z"},
        {"trial_id": "t2", "criterion": "c", "value": "unsure", "labelled_at": "2026-11-05T10Z"},
    ]
    f = tmp_path / "tuning.jsonl"
    f.write_text("\n".join(json.dumps(x) for x in lines) + "\nnot json\n")
    first, relabels = read_labels(f)
    assert first == {("t1", "c"): "yes", ("t2", "c"): "unsure"}
    assert relabels == [("t1:c", "yes", "no")]


def test_a_second_look_replaces_an_unsure_and_is_not_a_relabel(tmp_path):
    lines = [
        {"trial_id": "t1", "criterion": "c", "value": "unsure", "labelled_at": "2026-11-05T09:00Z"},
        {
            "trial_id": "t1",
            "criterion": "c",
            "value": "no",
            "labelled_at": "2026-11-05T10:00Z",
            "second_look": True,
        },
        {"trial_id": "t2", "criterion": "c", "value": "unsure", "labelled_at": "2026-11-05T09:00Z"},
        {
            "trial_id": "t2",
            "criterion": "c",
            "value": "unsure",
            "labelled_at": "2026-11-05T10:00Z",
            "second_look": True,
        },
        # Only an "unsure" can be looked at again, and only once.
        {"trial_id": "t3", "criterion": "c", "value": "yes", "labelled_at": "2026-11-05T09:00Z"},
        {
            "trial_id": "t3",
            "criterion": "c",
            "value": "no",
            "labelled_at": "2026-11-05T10:00Z",
            "second_look": True,
        },
        {
            "trial_id": "t1",
            "criterion": "c",
            "value": "yes",
            "labelled_at": "2026-11-05T11:00Z",
            "second_look": True,
        },
    ]
    f = tmp_path / "tuning.jsonl"
    f.write_text("\n".join(json.dumps(x) for x in lines) + "\n")
    first, relabels = read_labels(f)
    assert first == {("t1", "c"): "no", ("t2", "c"): "unsure", ("t3", "c"): "yes"}
    assert relabels == []


def test_judge_verdicts_come_from_the_judge_grades_criterion_items():
    trial = {
        "grades": [
            {"type": "number", "evidence": [{"source": "final_answer", "quote": "x"}]},
            {
                "type": "judge",
                "evidence": [
                    {"criterion": "tone", "verdict": "yes", "source": "agent_message"},
                    {"criterion": "numbers", "verdict": "missing", "source": "judge"},
                    {"source": "judge_call", "model": "fake/judge"},
                ],
            },
            {"type": "judge", "verdict": "not_implemented", "evidence": []},
        ]
    }
    assert judge_verdicts(trial) == {"tone": "yes", "numbers": "missing"}
