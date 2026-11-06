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


def test_d73_each_rater_reads_apart_and_another_raters_answer_is_not_a_relabel(tmp_path):
    from evals_stats.agreement_cli import read_labels, read_rater_labels

    path = tmp_path / "heldout.jsonl"
    rows = [
        {"trial_id": "t1", "criterion": "overall", "value": "yes", "labelled_at": "T1"},
        {
            "trial_id": "t1",
            "criterion": "overall",
            "value": "no",
            "labelled_at": "T2",
            "rater": "asha",
        },
        {
            "trial_id": "t1",
            "criterion": "overall",
            "value": "no",
            "labelled_at": "T3",
            "rater": "rishi",
        },
    ]
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))
    by_rater = read_rater_labels(path)
    # The first line has no rater, so it is Rishi's; his third line is his relabel; Asha's is not.
    assert by_rater["rishi"] == ({("t1", "overall"): "yes"}, [("t1:overall", "yes", "no")])
    assert by_rater["asha"] == ({("t1", "overall"): "no"}, [])
    assert read_labels(path) == by_rater["rishi"]
    assert read_labels(path, "asha") == by_rater["asha"]


def test_d73_majority_and_raters_against_each_other():
    from evals_stats.agreement import between_raters, human_majority

    a = {("t1", "c"): "yes", ("t2", "c"): "no", ("t3", "c"): "yes"}
    b = {("t1", "c"): "yes", ("t2", "c"): "yes", ("t3", "c"): "unsure"}
    assert human_majority({"a": a, "b": b}, "exclude") == {
        ("t1", "c"): "yes",
        ("t2", "c"): "tie",  # a tie is left out
        ("t3", "c"): "yes",  # b unsure, a's firm answer decides
    }
    [pair] = between_raters({"a": a, "b": b}, "exclude")
    assert pair["raters"] == ["a", "b"] and pair["n"] == 2 and pair["agreement"] == 0.5


def test_d73_a_firm_tie_is_left_out_under_either_unsure_policy():
    """S11: under --human-unsure no, the tie came back as "unsure" and so counted as a human no:
    a judge's yes on it read as a false pass."""
    from evals_stats.agreement import human_majority

    labels = {"rishi": {("t1", "c"): "yes"}, "asha": {("t1", "c"): "no"}}
    for policy in ("exclude", "no"):
        majority = human_majority(labels, policy)
        assert majority == {("t1", "c"): "tie"}
        assert human_value("tie", policy) is None
        [r] = report([Pair("t1", "c", majority[("t1", "c")], "yes", "A")], policy, resamples=10)
        assert r.table.n == 0 and r.table.fp == 0 and r.human_left_out == 1
    # Nobody firm: "unsure", which the policy decides (here: two unsure raters, so a no).
    both_unsure = {"rishi": {("t1", "c"): "unsure"}, "asha": {("t1", "c"): "unsure"}}
    assert human_majority(both_unsure, "exclude") == {("t1", "c"): "unsure"}
    assert human_majority(both_unsure, "no") == {("t1", "c"): "no"}


# ---- the destructive review, 6 Nov (S2, S3): synthetic verdicts only ------------------------


def test_the_false_pass_gap_is_signed_b_minus_a():
    # arm A: false-pass rate 5/10; arm B: 1/10. B - A = -0.4; the old max - min said +0.4.
    ps = pairs_for(10, 5, 0, 5, arm="A") + pairs_for(10, 1, 0, 9, arm="B")
    [r] = report(ps, "exclude", resamples=300)
    assert r.false_pass_gap == pytest.approx(-0.4)
    [g] = r.false_pass_gaps
    assert g.arms == ("A", "B") and g.interval.high < 0
    assert r.no_false_pass_gap is False
    assert "the false-pass rate differs between arms" in "; ".join(r.d8["reasons"])


def test_an_unbiased_judge_passes_the_gap_check_about_95_times_in_100():
    """The reviewer's simulation (gap_sim.py): the same false-pass rate in both arms. The unsigned
    gap's interval held 0 in 1.5% of runs at 20 "no" labels per arm and 0% at 40."""
    import random

    rng = random.Random(1)
    held, signs = 0, set()
    runs = 40
    for run in range(runs):
        ps = [
            Pair(f"{arm}{i}", "c", "no", "yes" if rng.random() < 0.3 else "no", arm)
            for arm in ("A", "B")
            for i in range(20)
        ]
        [r] = report(ps, "exclude", resamples=300, seed=run)
        held += r.no_false_pass_gap is True
        if r.false_pass_gap:
            signs.add(r.false_pass_gap > 0)
    assert held / runs >= 0.85
    assert signs == {True, False}


def test_one_arm_has_no_gap_to_check():
    [r] = report(pairs_for(10, 1, 1, 10, arm="A"), "exclude", resamples=100)
    assert r.false_pass_gaps == [] and r.false_pass_gap is None and r.no_false_pass_gap is None
    assert "the false-pass gap between arms could not be measured" in r.d8["reasons"]


def test_three_arms_check_every_pair():
    ps = (
        pairs_for(10, 1, 0, 9, arm="A")
        + pairs_for(10, 1, 0, 9, arm="B")
        + pairs_for(10, 8, 0, 2, arm="C")
    )
    [r] = report(ps, "exclude", resamples=300)
    assert [g.arms for g in r.false_pass_gaps] == [("A", "B"), ("A", "C"), ("B", "C")]
    assert r.false_pass_gap is None  # only given for two arms
    assert r.no_false_pass_gap is False


def test_an_interval_from_too_many_undefined_resamples_is_undefined():
    # One human "no", and the judge agrees on all 30: kappa 1, but about a third of the resamples
    # leave the one "no" out, where kappa is undefined. Dropping them silently gave [1, 1].
    ps = [
        Pair(f"t{i}", "c", "no" if i == 0 else "yes", "no" if i == 0 else "yes") for i in range(30)
    ]
    [r] = report(ps, "exclude", resamples=2000)
    assert r.table.tn == 1 and r.table.tp == 29
    assert r.table.kappa == pytest.approx(1.0)
    k = r.intervals["kappa"]
    assert k.low is None and k.high is None and k.drawn == 2000
    assert 0.3 < k.undefined_share < 0.42
    assert k.as_dict()["undefined_share"] == k.undefined_share
    reasons = r.d8["reasons"]
    assert reasons[0] == '1 human "no" labels, fewer than 5'
    assert any(x.startswith("kappa's interval is undefined (") for x in reasons)
    assert r.d8["trusted"] is False


def test_an_interval_with_a_few_undefined_resamples_stays_and_says_how_many():
    from evals_stats.agreement import MAX_UNDEFINED_SHARE

    values = list(range(100))
    # Undefined when the resample's first item is 0..2: about 3% of resamples.
    iv = bootstrap(values, lambda s: None if s[0] < 3 else sum(s) / len(s), resamples=1000)
    assert iv.low is not None and 0 < iv.undefined_share <= MAX_UNDEFINED_SHARE
    iv = bootstrap(values, lambda s: None if s[0] < 10 else 1.0, resamples=1000)
    assert iv.low is None and iv.undefined_share > MAX_UNDEFINED_SHARE


def test_the_corrected_rate_interval_counts_its_undefined_resamples():
    # The reviewer's rg.py: 28 agreed passes, 1 agreed fail, 4 false passes. A resample without the
    # one agreed fail has specificity 0, a judge no better than chance: no corrected rate.
    labelled = [Pair(f"y{i}", "c", "yes", "yes") for i in range(28)] + [Pair("n0", "c", "no", "no")]
    labelled += [Pair(f"n{i}", "c", "no", "yes") for i in range(1, 5)]
    out = corrected_rate([True] * 90 + [False] * 10, labelled, "exclude", resamples=2000)
    iv = out["interval"]
    assert iv["low"] is None and iv["drawn"] == 2000 and iv["undefined_share"] > 0.3


def test_d8_trusts_a_good_judge_only_with_test_retest_measured():
    from evals_stats.agreement import d8_check

    ps = pairs_for(20, 1, 1, 18, arm="A") + pairs_for(20, 1, 1, 18, arm="B")
    [r] = report(ps, "exclude", resamples=500, retest={"c": 0.95})
    assert r.table.kappa > 0.85 and r.intervals["kappa"].low > 0.6
    assert r.d8 == {"trusted": True, "reasons": []}
    assert d8_check(r) == {"trusted": False, "reasons": ["test-retest agreement is not measured"]}
    assert d8_check(r, 0.85)["reasons"] == ["test-retest agreement 85% is below 90%"]


def test_d8_needs_five_human_no_labels():
    from evals_stats.agreement import MIN_HUMAN_NO

    assert MIN_HUMAN_NO == 5
    ps = pairs_for(30, 0, 1, 2, arm="A") + pairs_for(30, 0, 1, 2, arm="B")
    [r] = report(ps, "exclude", resamples=300, retest={"c": 1.0})
    assert r.table.fp + r.table.tn == 4
    assert r.d8["reasons"][0] == '4 human "no" labels, fewer than 5'
    assert r.as_dict()["human_no"] == 4


def test_the_cli_prints_the_signed_gap_undefined_intervals_and_d8(tmp_path, monkeypatch, capsys):
    from evals_stats import agreement_cli

    # Synthetic: 12 trials per arm, the judge passes one of each arm's 4 human "no"s.
    trials, lines = {}, []
    for arm in ("A", "B"):
        for i in range(12):
            tid = f"{arm}{i}"
            human = "no" if i < 4 else "yes"
            judge = "yes" if i == 0 or human == "yes" else "no"
            trials[tid] = {
                "config": {"name": f"arm {arm}", "hash": f"sha256:{arm * 8}"},
                "task": {"id": "t"},
                "grades": [{"type": "judge", "evidence": [{"criterion": "c", "verdict": judge}]}],
            }
            lines.append({"trial_id": tid, "criterion": "c", "value": human, "labelled_at": "T"})
    (tmp_path / "heldout.jsonl").write_text("".join(json.dumps(x) + "\n" for x in lines))
    monkeypatch.setattr(agreement_cli, "get", lambda _api, path: trials[path.split("/")[-1]])
    args = ["--set", "heldout", "--human-unsure", "exclude", "--labels", str(tmp_path)]
    assert agreement_cli.main([*args, "--resamples", "300"]) == 0
    out = capsys.readouterr().out
    assert "False-pass gap: arm B (BBBBBBBB) minus arm A (AAAAAAAA)." in out
    assert "| 0.00 (" in out  # both arms pass 1 of 4: a signed gap of 0
    # 8 human "no" labels and a kappa interval of about 0.5 to 1: only the retest is missing.
    assert "- c: not trusted: test-retest agreement is not measured\n" in out
    assert agreement_cli.main([*args, "--resamples", "300", "--json"]) == 0
    [c] = json.loads(capsys.readouterr().out)["criteria"]
    assert c["false_pass_gap"] == 0 and c["false_pass_gaps"][0]["includes_zero"] is True
    assert c["d8"]["trusted"] is False
