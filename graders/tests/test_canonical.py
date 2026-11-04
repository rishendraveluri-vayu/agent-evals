import json
from pathlib import Path

import pytest

from evals_graders.canonical import canonical_json, grader_version, spec_sha256

VECTORS = json.loads((Path(__file__).parent / "hash_vectors.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda c: c["spec"]["id"])
def test_shared_vectors_match_the_api(case):
    """apps/api/src/grading/grading.spec.ts checks the same file with the API's hashing."""
    assert spec_sha256(case["spec"], case["files"]) == case["spec_sha256"]
    assert (
        grader_version(case["spec_sha256"], VECTORS["framework_version"]) == case["grader_version"]
    )


@pytest.mark.parametrize(
    ("value", "text"),
    [
        (1.0, "1"),
        (101341.01, "101341.01"),
        (0.000015, "0.000015"),
        (1e-7, "1e-7"),
        (1e21, "1e+21"),
        (1e20, "100000000000000000000"),
        (-0.5, "-0.5"),
        (0.0, "0"),
        (12345678901234567890, "12345678901234567890"),
    ],
)
def test_numbers_as_javascript_writes_them(value, text):
    assert canonical_json(value) == text


def test_keys_sorted_strings_unescaped():
    assert (
        canonical_json({"b": "₹1", "a": [True, None, 'x\n"y']})
        == '{"a":[true,null,"x\\n\\"y"],"b":"₹1"}'
    )


def test_refuses_what_it_cannot_hash():
    with pytest.raises(TypeError):
        canonical_json(float("nan"))
    with pytest.raises(TypeError):
        canonical_json({1: "x"})
