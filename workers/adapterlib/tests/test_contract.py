"""The contract v2 schemas: the examples validate, and the mistakes they exist to catch fail."""

import copy
import json

import jsonschema
import pytest
from support import CONTRACT, FIXTURES, errors, make_spec, validator

from evals_adapter.spec import SpecError, check_spec

EXAMPLES = CONTRACT / "examples"


def test_every_schema_is_a_valid_json_schema():
    for path in CONTRACT.glob("*.schema.json"):
        jsonschema.Draft202012Validator.check_schema(json.loads(path.read_text()))


@pytest.mark.parametrize(
    ("example", "schema"),
    [
        ("spec.json", "spec"),
        ("spec-client-sim.json", "spec"),
        ("result.json", "result"),
        ("capabilities.json", "capabilities"),
        ("runner-report.json", "runner-report"),
    ],
)
def test_examples_validate(example, schema):
    assert errors(schema, json.loads((EXAMPLES / example).read_text())) == []


def test_trace_example_validates_line_by_line():
    lines = (EXAMPLES / "trace.jsonl").read_text().splitlines()
    assert len(lines) >= 4
    for line in lines:
        assert errors("span", json.loads(line)) == []


def test_test_spec_and_fixture_capabilities_validate():
    assert errors("spec", make_spec()) == []
    assert errors("capabilities", json.loads((FIXTURES / "capabilities.json").read_text())) == []


@pytest.mark.parametrize(
    "change",
    [
        {"contract_version": "1"},
        {"settings.temperature": 3},
        {"settings.timeout_s": 0},
        {"model.api_key_env": "lower-case"},
        {"trial.config_hash": "abc"},
        {"trial.task_split": "train"},
        {"settings_sources.temperature": "harness_default"},
        {"task.messages": []},
    ],
)
def test_spec_schema_rejects(change):
    assert errors("spec", make_spec(**change)) != []


def test_spec_schema_rejects_a_key_in_the_file():
    spec = make_spec()
    spec["model"]["api_key"] = "sk-123"
    assert errors("spec", spec) != []


def test_result_rejects_unknown_end_state_and_bad_artifact_path():
    result = json.loads((EXAMPLES / "result.json").read_text())
    bad = copy.deepcopy(result)
    bad["end_state"] = "kinda_answered"
    assert errors("result", bad) != []
    bad = copy.deepcopy(result)
    bad["artifacts"] = ["/etc/passwd"]
    assert errors("result", bad) != []


def test_span_rejects_bad_ids_and_numbers():
    span = json.loads((EXAMPLES / "trace.jsonl").read_text().splitlines()[0])
    for field, value in [
        ("traceId", "XYZ"),
        ("spanId", "123"),
        ("startTimeUnixNano", 5),
        ("kind", 0),
    ]:
        bad = copy.deepcopy(span)
        bad[field] = value
        assert not validator("span").is_valid(bad), field


def test_stdlib_check_matches_the_schema_on_the_basics():
    check_spec(make_spec())
    for change in [{"contract_version": "1"}, {"task.messages": []}, {"settings.timeout_s": 0}]:
        with pytest.raises(SpecError):
            check_spec(make_spec(**change))
