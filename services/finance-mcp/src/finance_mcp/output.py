"""Canonical JSON for tool results.

One encoding for every tool, so the bytes a harness receives depend only on the inputs:

- keys in the order the tool built them (never sorted, never reordered);
- compact separators `,` and `:`, no whitespace;
- non-ASCII kept as UTF-8 (`₹`, not `\\u20b9`);
- Decimal written exactly as it stands, so money always has two decimals (`1000.10`);
- floats refused, so no binary rounding can leak into an output.
"""

import json
from decimal import Decimal


def to_json(value: object) -> str:
    parts: list[str] = []
    _encode(value, parts)
    return "".join(parts)


def _encode(value: object, out: list[str]) -> None:
    if value is None:
        out.append("null")
    elif value is True:
        out.append("true")
    elif value is False:
        out.append("false")
    elif isinstance(value, int):
        out.append(str(value))
    elif isinstance(value, Decimal):
        if not value.is_finite():
            raise ValueError(f"non-finite Decimal in output: {value}")
        out.append(f"{value:f}")
    elif isinstance(value, str):
        out.append(json.dumps(value, ensure_ascii=False))
    elif isinstance(value, list | tuple):
        out.append("[")
        for index, item in enumerate(value):
            if index:
                out.append(",")
            _encode(item, out)
        out.append("]")
    elif isinstance(value, dict):
        out.append("{")
        for index, (key, item) in enumerate(value.items()):
            if not isinstance(key, str):
                raise TypeError(f"output keys must be strings, got {type(key).__name__}")
            if index:
                out.append(",")
            out.append(json.dumps(key, ensure_ascii=False))
            out.append(":")
            _encode(item, out)
        out.append("}")
    else:
        raise TypeError(f"cannot encode {type(value).__name__} in a tool result")
