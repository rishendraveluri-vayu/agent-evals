import pytest

from evals_graders.amounts import context, find, find_numbers, fmt_inr, within


@pytest.mark.parametrize(
    ("text", "value", "quoted"),
    [
        ("paying roughly **₹1,01,341** in interest", 101341.0, "₹1,01,341"),
        ("about ₹1,01,341.01 in total", 101341.01, "₹1,01,341.01"),
        ("Rs 20,000 a month", 20000.0, "Rs 20,000"),
        ("Rs.20,000 a month", 20000.0, "Rs.20,000"),
        ("INR 5,000 now", 5000.0, "INR 5,000"),
        ("20,000 rupees a month", 20000.0, "20,000 rupees"),
        ("on top of the ₹4.41 lakh you owe", 441000.0, "₹4.41 lakh"),
        ("a 1.2 crore flat", 12000000.0, "1.2 crore"),
        ("Rs 3 lakhs", 300000.0, "Rs 3 lakhs"),
        ("₹20k extra", 20000.0, "₹20k"),
        ("441,050 in total", 441050.0, "441,050"),
        ("₹ 8,997", 8997.0, "₹ 8,997"),
    ],
)
def test_reads_rupee_amounts(text, value, quoted):
    found = find(text)
    assert [(f.value, f.text) for f in found] == [(value, quoted)]
    # the text kept is exactly what the answer says
    assert found[0].text in text


def test_bare_numbers_are_not_amounts_but_any_takes_them():
    text = "debt-free in 28 months at 42% a year"
    assert find(text) == []
    assert [f.value for f in find(text, "any")] == [28.0, 42.0]


def test_does_not_split_tokens_or_lists():
    assert [f.value for f in find_numbers("v5 and step2")] == []
    assert [f.value for f in find_numbers("4.41")] == [4.41]  # never 41 on its own
    assert find_numbers("debts 1,2,3") == []  # not a grouped number
    assert [f.value for f in find_numbers("months 15, 19, 28")] == [15.0, 19.0, 28.0]


def test_k_needs_a_rupee_marker():
    assert [(f.value, f.is_amount) for f in find_numbers("20k steps")] == [(20.0, False)]


def test_tolerance_abs_rel_and_the_looser_wins():
    assert within(101341.0, 101341.01, {"abs": 1})
    assert not within(101000.0, 101341.01, {"abs": 1})
    assert within(101000.0, 101341.01, {"rel": 0.005})
    assert within(101000.0, 101341.01, {"abs": 1, "rel": 0.005})
    assert not within(100000.0, 101341.01, {"abs": 1, "rel": 0.005})
    assert within(5.0, 5.0, {})
    assert not within(5.01, 5.0, {})


def test_context_is_a_verbatim_line_slice():
    text = "First line.\nYou pay ₹1,01,341 in interest over the plan.\nLast line."
    start = text.index("₹")
    quote = context(text, start, start + len("₹1,01,341"))
    assert quote == "You pay ₹1,01,341 in interest over the plan."
    assert quote in text


def test_indian_format():
    assert fmt_inr(101341.01) == "₹1,01,341.01"
    assert fmt_inr(441050) == "₹4,41,050"
    assert fmt_inr(999) == "₹999"
    assert fmt_inr(12345678.5) == "₹1,23,45,678.50"


# ---- G10 (6 Nov review): the grader's money reader and the runner's agree --------------------

# Marked amounts in the forms the review found the two readers split on (a no-break space after
# the marker, markdown bold, a minus after the marker, "₹49.41L"), and the everyday forms. Each
# case: the text and the rupee values both readers must find, in order.
SHARED_CASES = [
    ("₹45,000 a month", [45000]),
    ("₹ 45,000 a month", [45000]),
    ("₹ 45,000 a month", [45000]),  # no-break space
    ("₹ 45,000 a month", [45000]),  # narrow no-break space
    ("Rs. 45,000 and INR 500", [45000, 500]),  # thin space
    ("₹**45,000** a month", [45000]),
    ("**₹45,000** a month", [45000]),
    ("₹ **45,000** a month", [45000]),
    ("a refund of ₹-5,000", [5000]),
    ("a refund of ₹−5,000", [5000]),  # U+2212
    ("a refund of -₹5,000", [5000]),
    ("₹49.41L in interest", [4941000]),
    ("₹49.41 L in interest", [4941000]),
    ("₹4.41 lakh, ₹4.41 lakh and ₹**4.41 lakh**", [441000, 441000, 441000]),
    ("Rs 2 crore, ₹1.5 cr", [20000000, 15000000]),
    ("INR 18332.5 and ₹8,997.26", [18332.5, 8997.26]),
    ("₹92k, ₹20 thousand and ₹1.2 million", [92000, 20000, 1200000]),
    ("5,000 rupees, or 5,000 rupees", [5000, 5000]),
    ("₹1,01,341 overall", [101341]),
]


def _runner_reader():
    import sys
    from pathlib import Path

    src = Path(__file__).resolve().parents[2] / "workers" / "adapterlib" / "src"
    if str(src) not in sys.path:
        sys.path.insert(0, str(src))
    from evals_adapter.checks import money_amounts

    return money_amounts


@pytest.mark.parametrize(("text", "values"), SHARED_CASES)
def test_the_grader_and_the_runner_read_the_same_marked_amounts(text, values):
    money_amounts = _runner_reader()
    runner = [float(a.value) for a in money_amounts(text)]
    grader = [f.value for f in find(text, "amount")]
    assert runner == pytest.approx(values)
    assert grader == pytest.approx(values)
    for f in find(text, "amount"):
        assert f.text in text


def test_where_the_readers_differ_on_purpose():
    """Unmarked amounts: the grader reads Western grouping (45,000) as an amount, the runner only
    Indian grouping from a lakh up, and the runner reads a bare range end after a marked amount;
    'L' after an unmarked number is a litre to both."""
    money_amounts = _runner_reader()
    assert [f.value for f in find("45,000 a month", "amount")] == [45000]
    assert money_amounts("45,000 a month") == []
    assert [float(a.value) for a in money_amounts("₹8,000–9,000")] == [8000, 9000]
    assert [f.value for f in find("12 L of milk", "any")] == [12]
    assert money_amounts("12 L of milk") == []


def test_long_digit_runs_are_quick_and_not_numbers():
    """G6 (6 Nov review): NUMBER_RE's lookahead was quadratic: a 60,000-digit run followed by
    letters and a digit took the unit test past its timeout. Digit runs are capped at 30."""
    import time

    money_amounts = _runner_reader()
    for text in (
        "Ref " + "1" * 60_000 + "x1",
        "₹" + "9" * 60_000 + ".",
        "₹" + ",999" * 15_000,
    ):
        started = time.perf_counter()
        found = find(text, "any")
        money = money_amounts(text)
        assert time.perf_counter() - started < 2.0
        assert all(len(f.text) < 500 for f in found)
        assert all(len(a.text) < 500 for a in money)
    assert find("₹" + "9" * 31, "any") == []
    assert [f.value for f in find("₹" + "9" * 30, "any")] == [float("9" * 30)]
