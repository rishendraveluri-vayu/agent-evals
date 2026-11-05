"""reference_rates (D58, 5 Nov): documented Indian market assumptions from reference_rates.json.

The values were approved by Rishi on 5 Nov, with debt_fund removed at review (an index return,
not what a debt-fund investor earns after costs). These tests pin the shape the agent sees, keep
every number in the result a rate (so its text adds no stray sources to the provenance check),
reject a malformed edit at startup, and tie the served bytes to the server version.
"""

import copy
import hashlib
import json
import re
from decimal import Decimal
from pathlib import Path

import pytest
from finance_mcp import __version__, reference
from finance_mcp.output import to_json
from finance_mcp.server import create_server
from support import call, ok, text_of

KEYS = [
    "fd_1y",
    "savings_account",
    "ppf",
    "inflation_cpi",
    "rbi_repo",
    "equity_long_run",
]
# The tool's result at each server version. A change to a value, a source, a date or a word in
# reference_rates.json changes it: then bump the server version (__init__.py, pyproject.toml),
# which makes a new toolset hash in the API, and pin the new bytes here. Do not re-pin a version
# a recorded trial used.
# 0.4.0 (5 Nov, D58): seven rates, proposed. 0.4.1 (5 Nov): approved, debt_fund removed. Nothing
# ran on 0.4.0.
PINNED = {
    "0.4.0": "2a96dce25e60059cd170f44bff18a80605feb3f548a5e4dc6d4c99fcee2c09dc",
    "0.4.1": "c90c50fca8e8cbd97d749e34b2336f554dbfba706b046759eb5084934fd0e89d",
}

URL = re.compile(r"https?://[^\s\"'<>]+")
DATE = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")
# A number as the runner's provenance check reads one: not glued to a word or a decimal point.
NUMBER = re.compile(r"(?<![\w.])\d+(?:,\d+)*(?:\.\d+)?")


def served(state_dir: Path) -> str:
    return text_of(call(create_server(state_dir), "reference_rates", {}))


def test_the_result_is_every_rate_with_its_value_unit_source_and_date(state_dir: Path) -> None:
    result = ok(create_server(state_dir), "reference_rates", {})
    assert list(result) == ["compiled_on", "note", "rates"]
    assert result["compiled_on"] == "2026-11-05"
    assert "not live rates" in result["note"]
    assert list(result["rates"]) == KEYS
    for key, rate in result["rates"].items():
        assert list(rate) == ["name", "value", "unit", "as_of", "as_of_means", "source"], key
        assert isinstance(rate["value"], int | float), key
        assert rate["unit"].startswith("percent"), key
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", rate["as_of"]), key
        assert rate["as_of"] <= result["compiled_on"], key
        assert list(rate["source"]) == ["organisation", "url"], key
        assert rate["source"]["url"].startswith("https://"), key
    # The evidence for the reviewer stays in the file.
    assert "evidence" not in served(state_dir)


def test_values_keep_the_digits_they_were_written_with(state_dir: Path) -> None:
    text = served(state_dir)
    data = reference.load()
    for key in KEYS:
        value = data["rates"][key]["value"]
        assert isinstance(value, Decimal)
        assert f'"{key}":{{"name":' in text
        assert f'"value":{value:f},' in text, key
    assert '"value":7.10,' in text and '"value":2.50,' in text


def test_the_only_numbers_in_the_result_are_the_rates(state_dir: Path) -> None:
    """Every other digit in the result is in a date or a URL, which the provenance check skips,
    or glued to a word (Nifty50). So the result supports exactly its rates: no 2024 from a base
    year or 3 from "3 crore" becomes a source."""
    text = served(state_dir)
    rest = DATE.sub(" ", URL.sub(" ", text))
    numbers = NUMBER.findall(rest)
    values = [f"{reference.load()['rates'][key]['value']:f}" for key in KEYS]
    assert numbers == values


def test_the_equity_return_says_it_is_a_past_return_not_a_promise(state_dir: Path) -> None:
    rates = ok(create_server(state_dir), "reference_rates", {})["rates"]
    assert "not a promise or a forecast" in rates["equity_long_run"]["name"]
    assert "before fund costs and tax" in rates["equity_long_run"]["name"]
    assert "debt_fund" not in rates  # removed at Rishi's review, 5 Nov


def test_the_served_bytes_are_pinned_to_the_server_version(state_dir: Path) -> None:
    digest = hashlib.sha256(served(state_dir).encode("utf-8")).hexdigest()
    assert __version__ in PINNED, f"pin reference_rates at {__version__}: {digest}"
    assert digest == PINNED[__version__], (
        "reference_rates.json changed: bump the server version and pin the new bytes"
    )


def test_the_file_ships_in_the_package() -> None:
    from importlib import resources

    assert resources.files("finance_mcp").joinpath(reference.DATA_FILE).is_file()


def _raw() -> dict:
    path = Path(reference.__file__).with_name(reference.DATA_FILE)
    return json.loads(path.read_text(encoding="utf-8"), parse_float=Decimal)


@pytest.mark.parametrize(
    ("edit", "message"),
    [
        (lambda d: d["rates"]["fd_1y"].pop("as_of"), "rates.fd_1y must have exactly"),
        (lambda d: d["rates"]["ppf"].update(rate=7.1), "rates.ppf must have exactly"),
        (lambda d: d["rates"]["ppf"].update(value="7.10"), "rates.ppf.value must be a number"),
        (lambda d: d["rates"]["ppf"].update(value=True), "rates.ppf.value must be a number"),
        (lambda d: d["rates"]["rbi_repo"].update(as_of="2026-13-01"), "must be a real date"),
        (lambda d: d["rates"]["rbi_repo"].update(as_of="2026-12-01"), "after compiled_on"),
        (lambda d: d["rates"]["fd_1y"].update(evidence=" "), "evidence must be non-empty"),
        (
            lambda d: d["rates"]["fd_1y"]["source"].update(url="http://sbi.bank.in"),
            "url must be an https URL",
        ),
        (lambda d: d["rates"]["fd_1y"]["source"].pop("organisation"), "source must have exactly"),
        (lambda d: d.update(rates={}), "rates must be a non-empty object"),
        (lambda d: d.pop("note"), "exactly compiled_on, approval, note and rates"),
        (lambda d: d.update(approval=""), "approval must be non-empty text"),
    ],
)
def test_a_malformed_edit_is_refused(edit, message: str) -> None:
    data = copy.deepcopy(_raw())
    reference.validate(data)  # the file as it stands is fine
    edit(data)
    with pytest.raises(reference.ReferenceDataError, match=re.escape(message)):
        reference.validate(data)


def test_the_tool_result_is_the_file_without_its_evidence_or_approval() -> None:
    data = _raw()
    out = json.loads(to_json(reference.reference_rates(reference.load())), parse_float=Decimal)
    for rate in data["rates"].values():
        rate.pop("evidence")
    assert data.pop("approval") == (
        "approved by Rishi, 5 Nov; debt_fund removed at review (an index return, not what a"
        " debt-fund investor earns after costs)"
    )
    assert out == data
