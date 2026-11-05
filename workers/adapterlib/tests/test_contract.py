"""The contract v2 schemas: the examples validate, and the mistakes they exist to catch fail."""

import copy
import json

import jsonschema
import pytest
from support import CONTRACT, FIXTURES, errors, make_spec, schema, validator

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
        ("runner-report-config-error.json", "runner-report"),
        ("result-sim-error.json", "result"),
        ("runner-report-sim-error.json", "runner-report"),
        ("checks.json", "checks"),
        ("checks-arithmetic.json", "checks"),
    ],
)
def test_examples_validate(example, schema):
    assert errors(schema, json.loads((EXAMPLES / example).read_text())) == []


def test_a_checks_json_from_before_d56_still_validates():
    """D56's fields are additive: without `arithmetic`, `rejected` and `match.call`, a checks.json
    is the shape the runner wrote before 5 Nov, and the schema still takes it."""
    checks = json.loads((EXAMPLES / "checks-arithmetic.json").read_text())
    checks.pop("arithmetic")
    for row in checks["amounts"]:
        row.pop("rejected")
        if row["match"]:
            row["match"].pop("call")
    assert errors("checks", checks) == []
    checks["amounts"][0]["rejected"] = {"value": 1, "where": "tool:add"}  # but not half of one
    assert errors("checks", checks) != []


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
        {"settings_sources.temperature": "made_up"},
        {"task.messages": []},
    ],
)
def test_spec_schema_rejects(change):
    assert errors("spec", make_spec(**change)) != []


def test_spec_schema_takes_an_unset_setting_as_harness_default():
    """D25: an unset temperature is null in the spec with source harness_default (not sent)."""
    spec = make_spec(
        **{"settings.temperature": None, "settings_sources.temperature": "harness_default"}
    )
    assert errors("spec", spec) == []


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


def test_our_event_names_are_the_listed_ones():
    """Contract v2 section 7: an `evals.*` span event must be one of the listed names, so a new
    harness's memory or skill events reach the trial page; other event names stay free."""
    base = {
        "traceId": "0" * 32,
        "spanId": "0" * 16,
        "name": "agent.turn",
        "kind": 1,
        "startTimeUnixNano": "1",
        "endTimeUnixNano": "2",
        "attributes": [],
        "status": {"code": 1},
    }
    for name in ("evals.memory.read", "evals.skill.load", "evals.error", "exception"):
        assert errors("span", {**base, "events": [{"timeUnixNano": "1", "name": name}]}) == [], name
    assert errors("span", {**base, "events": [{"timeUnixNano": "1", "name": "evals.memory_read"}]})


def test_the_span_writer_refuses_an_unlisted_evals_event(tmp_path):
    """O1: the runner checks event names as the adapter emits them, against the schema's list."""
    from evals_adapter.trace import EVENT_NAMES, Tracer

    enum = schema("span")["properties"]["events"]["items"]["properties"]["name"]["anyOf"][0]["enum"]
    assert set(enum) == EVENT_NAMES
    span = Tracer(tmp_path / "trace.jsonl", "t_test").start("agent.turn")
    for name in sorted(EVENT_NAMES) + ["exception", "custom.thing"]:
        span.event(name)
    with pytest.raises(ValueError, match="not a contract v2 event"):
        span.event("evals.memory_read")
    assert [e["name"] for e in span.events][-2:] == ["exception", "custom.thing"]
