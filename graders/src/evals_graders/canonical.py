"""Canonical JSON and grader versions, byte for byte the same as the API's.

The API (apps/api/src/common/hashing.ts, `canonicalJson`) hashes JavaScript's JSON.stringify
output with object keys sorted. Python's json.dumps writes some numbers differently (1.0 as
"1.0", 0.000015 as "1.5e-05"), so numbers are written here the way JavaScript writes them.
Shared test vectors in tests/test_canonical.py and apps/api/src/grading/grading.spec.ts keep
the two in step.

A grader's version is `sha256(canonical({"framework": <framework version>, "spec": <spec
sha256>}))`, where the spec sha256 covers the grader spec and, for a unit_test grader, the
sha256 of its grader file. Both inputs are strings, so the version never depends on number
formatting.
"""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any


def _js_number(value: float) -> str:
    """ECMAScript Number::toString for a finite double (what JSON.stringify writes)."""
    if value == 0:
        return "0"
    if value < 0:
        return "-" + _js_number(-value)
    # repr gives the shortest digits that round-trip, as JavaScript does; only the layout differs.
    mantissa, _, exp_text = repr(value).partition("e")
    whole, _, frac = mantissa.partition(".")
    digits = whole + frac
    # n is where the decimal point sits: value = 0.<digits> x 10^n
    n = len(whole) + (int(exp_text) if exp_text else 0)
    stripped = digits.lstrip("0")
    n -= len(digits) - len(stripped)
    digits = stripped.rstrip("0")
    k = len(digits)
    if k <= n <= 21:
        return digits + "0" * (n - k)
    if 0 < n <= 21:
        return digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return "0." + "0" * (-n) + digits
    e = n - 1
    sign = "+" if e >= 0 else "-"
    head = digits[0] + ("." + digits[1:] if k > 1 else "")
    return f"{head}e{sign}{abs(e)}"


def canonical_json(value: Any) -> str:
    """Keys sorted, no whitespace, strings and numbers as JSON.stringify writes them."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise TypeError(f"cannot hash the number {value}")
        return _js_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list | tuple):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value)
        for k in keys:
            if not isinstance(k, str):
                raise TypeError(f"object keys must be strings, got {k!r}")
        return (
            "{"
            + ",".join(
                json.dumps(k, ensure_ascii=False) + ":" + canonical_json(value[k]) for k in keys
            )
            + "}"
        )
    raise TypeError(f"cannot hash a {type(value).__name__}")


def sha256_ref(data: str | bytes) -> str:
    raw = data.encode("utf-8") if isinstance(data, str) else data
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def hash_canonical(value: Any) -> str:
    return sha256_ref(canonical_json(value))


def spec_sha256(spec: dict[str, Any], files: dict[str, str | None] | None = None) -> str:
    """The grader spec, plus the sha256 of each file it runs (a unit_test's grader.py)."""
    return hash_canonical({"spec": spec, "files": files or {}})


def grader_version(spec_hash: str, framework_version: str) -> str:
    return hash_canonical({"framework": framework_version, "spec": spec_hash})
