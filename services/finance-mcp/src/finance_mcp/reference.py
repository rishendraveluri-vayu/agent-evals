"""The `reference_rates` tool (D58, 5 Nov): documented Indian market assumptions, each with its
value, unit, source (organisation and URL) and the date it applies to.

The values live in `reference_rates.json` next to this module, so they can be read, approved and
edited in one place without touching code. They are a dated snapshot, not live rates: the server
has no clock and no network (README), so the same server version always serves the same bytes.
A test pins those bytes to the server version, so a change to a value is a new server version and
so a new toolset hash.

Each entry in the file also holds `evidence`: the verbatim text the value was read from, and
when, for whoever reviews the file, and the file says who approved it (`approval`: "approved
by Rishi, 5 Nov"). Neither is served; the agent sees `compiled_on`, `note` and, for each rate,
the fields in SERVED.

The file is checked when the server starts, so a malformed edit fails there, not in a trial.
"""

import json
from datetime import date
from decimal import Decimal
from importlib import resources
from typing import Any

DATA_FILE = "reference_rates.json"
# What the agent is shown for each rate, in this order. `evidence` stays in the file.
SERVED = ("name", "value", "unit", "as_of", "as_of_means", "source")
REQUIRED = (*SERVED, "evidence")


class ReferenceDataError(Exception):
    """reference_rates.json is malformed. The message names the bad field."""


def _real_date(value: object, where: str) -> date:
    if not isinstance(value, str):
        raise ReferenceDataError(f"{where} must be a date, YYYY-MM-DD")
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise ReferenceDataError(f"{where} must be a real date, YYYY-MM-DD") from None


def _text(value: object, where: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ReferenceDataError(f"{where} must be non-empty text")
    return value


def validate(data: Any) -> dict[str, Any]:
    """The file's content if it is well formed, else ReferenceDataError. Every rate has every
    field in REQUIRED and nothing else; values are numbers; dates are real and not after
    `compiled_on`; URLs are https."""
    if not isinstance(data, dict) or set(data) != {"compiled_on", "approval", "note", "rates"}:
        raise ReferenceDataError("the file must hold exactly compiled_on, approval, note and rates")
    compiled = _real_date(data["compiled_on"], "compiled_on")
    _text(data["approval"], "approval")
    _text(data["note"], "note")
    rates = data["rates"]
    if not isinstance(rates, dict) or not rates:
        raise ReferenceDataError("rates must be a non-empty object")
    for key, rate in rates.items():
        if not isinstance(rate, dict) or set(rate) != set(REQUIRED):
            raise ReferenceDataError(f"rates.{key} must have exactly {', '.join(REQUIRED)}")
        value = rate["value"]
        if isinstance(value, bool) or not isinstance(value, int | Decimal):
            raise ReferenceDataError(f"rates.{key}.value must be a number")
        for field in ("name", "unit", "as_of_means", "evidence"):
            _text(rate[field], f"rates.{key}.{field}")
        if _real_date(rate["as_of"], f"rates.{key}.as_of") > compiled:
            raise ReferenceDataError(f"rates.{key}.as_of is after compiled_on")
        source = rate["source"]
        if not isinstance(source, dict) or set(source) != {"organisation", "url"}:
            raise ReferenceDataError(f"rates.{key}.source must have exactly organisation and url")
        _text(source["organisation"], f"rates.{key}.source.organisation")
        if not _text(source["url"], f"rates.{key}.source.url").startswith("https://"):
            raise ReferenceDataError(f"rates.{key}.source.url must be an https URL")
    return data


def load() -> dict[str, Any]:
    """The rates file, read from the installed package, with numbers as Decimal so a value is
    served with exactly the digits it was written with (7.10, not 7.1)."""
    text = resources.files("finance_mcp").joinpath(DATA_FILE).read_text(encoding="utf-8")
    return validate(json.loads(text, parse_float=Decimal, parse_int=Decimal))


def reference_rates(data: dict[str, Any]) -> dict[str, Any]:
    """The tool's result: the snapshot date, the note, and every rate's served fields, in the
    file's order."""
    return {
        "compiled_on": data["compiled_on"],
        "note": data["note"],
        "rates": {
            key: {field: rate[field] for field in SERVED} for key, rate in data["rates"].items()
        },
    }
