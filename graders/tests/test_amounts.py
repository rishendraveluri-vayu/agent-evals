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
