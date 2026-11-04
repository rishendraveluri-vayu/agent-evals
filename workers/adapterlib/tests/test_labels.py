"""D26: provider-error labels, from LiteLLM's last status and the error the adapter reported.

The 400 messages below are copied exactly from the end_detail of the 4 Nov real trials
(runs/20261104T074349Z-real and runs/20261104T083111Z-real), as each harness reported them.
"""

import json

import pytest
from support import CONTRACT, errors

from evals_adapter.runner import label, provider_label

# The unscoped-key 400 (own loop, single trial, 4 Nov).
UNSCOPED_KEY = (
    "Error code: 400 - litellm.BadRequestError: AnthropicException - "
    '{"type":"error","error":{"type":"invalid_request_error","message":"This API key is not '
    "scoped to a workspace, so this request must include the anthropic-workspace-id header with "
    "the ID of the workspace to use. Add the header, or use an API key that is scoped to a "
    'workspace."},"request_id":"req_011CghWkuA86P2P7Ev167Xxo"}. Received Model Group='
    "claude-haiku-5-5\nAvailable Model Group Fallbacks=None"
)
# The temperature 400 (own loop, settings trial, 4 Nov).
TEMPERATURE = (
    "Error code: 400 - litellm.BadRequestError: AnthropicException - "
    '{"type":"error","error":{"type":"invalid_request_error","message":"`temperature` is '
    'deprecated for this model."},"request_id":"req_011CghaVC7rWXY8fBDCspAvF"}. Received Model '
    "Group=claude-haiku-5-5\nAvailable Model Group Fallbacks=None"
)
# The same temperature 400 as Hermes and the Agents SDK reported it (4 Nov).
TEMPERATURE_HERMES = (
    "HTTP 400: litellm.BadRequestError: AnthropicException - "
    'b\'{"type":"error","error":{"type":"invalid_request_error","message":'
    '"`temperature` is deprecated for this model."},"request_id":"req_011CghactEZ4sVLFfkH4FMPX"}\''
    ". Received Model Group=claude-haiku-5-5\nAvailable Model Group Fallbacks=None"
)
TEMPERATURE_AGENTS_SDK = (
    "Error code: 400 - {'error': {'message': 'litellm.BadRequestError: AnthropicException - "
    '{"type":"error","error":{"type":"invalid_request_error","message":"`temperature` is '
    'deprecated for this model."},"request_id":"req_011Cghb1y9rKSsk3uuNY1phY"}. Received Model '
    "Group=claude-haiku-5-5\\nAvailable Model Group Fallbacks=None', 'type': None, 'param': None, "
    "'code': '400'}}"
)
# Not seen on our runs: the shape Claude documents for a prompt over the context window.
CONTEXT_TOO_LONG = (
    "Error code: 400 - litellm.BadRequestError: AnthropicException - "
    '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: '
    '215000 tokens > 200000 maximum"}}. Received Model Group=claude-haiku-5-5'
)
# Not seen on our runs: a 400 that is about neither the setup nor the context.
OTHER_400 = (
    "Error code: 400 - litellm.BadRequestError: AnthropicException - "
    '{"type":"error","error":{"type":"invalid_request_error","message":"messages.2: `tool_use` '
    'ids were found without `tool_result` blocks immediately after"}}'
)

OK = {"signal": None, "exit_code": 0}


def harness_error(message: str | None, stop: str = "model call failed: BadRequestError") -> dict:
    return {
        "result": {
            "end_state": "harness_error",
            "end_detail": {
                "harness_stop_reason": stop,
                "exception_type": "BadRequestError",
                "exception_message": message,
                "last_message_excerpt": None,
            },
        }
    }


@pytest.mark.parametrize(
    ("message", "stop"),
    [
        (UNSCOPED_KEY, "model call failed: BadRequestError"),
        (TEMPERATURE, "model call failed: BadRequestError"),
        (TEMPERATURE_HERMES, "format_error"),
        (TEMPERATURE_AGENTS_SDK, "model call failed: BadRequestError"),
    ],
)
def test_the_4_nov_setup_400s_are_config_errors(message, stop):
    checked = harness_error(message, stop)
    assert label(OK, checked, {"last_status": "400"}) == "infra:config_error"


def test_a_context_too_long_400_stays_the_agents_outcome():
    assert label(OK, harness_error(CONTEXT_TOO_LONG), {"last_status": "400"}) == "agent"
    assert provider_label("400", harness_error(CONTEXT_TOO_LONG)["result"]) is None


def test_any_other_400_stays_the_agents_outcome():
    assert label(OK, harness_error(OTHER_400), {"last_status": "400"}) == "agent"
    assert label(OK, harness_error(None), {"last_status": "400"}) == "agent"


@pytest.mark.parametrize("status", ["401", "403", "404"])
def test_auth_permission_and_not_found_are_config_errors(status):
    assert label(OK, harness_error("Error code: " + status), {"last_status": status}) == (
        "infra:config_error"
    )


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        ("429", "infra:provider_error"),
        ("500", "infra:provider_error"),
        ("503", "infra:provider_error"),
        # D16: LiteLLM's per-call timeout, still failing after its retries (seen 4 Nov on
        # v1.99.4 with a hung fake call: one row, status 408, attempted_retries 3)
        ("408", "infra:provider_error"),
        ("budget_exceeded", "infra:budget_net"),
        ("200", "agent"),
    ],
)
def test_rate_limits_server_errors_and_budget_stops_keep_their_labels(status, expected):
    # The message would be a setup 400's, but LiteLLM's status decides first.
    assert label(OK, harness_error(UNSCOPED_KEY), {"last_status": status}) == expected


def test_without_a_litellm_record_the_message_alone_does_not_relabel():
    """D26 reads LiteLLM's status; with no proxy record (a direct fake run) nothing changes."""
    assert label(OK, harness_error(UNSCOPED_KEY), None) == "agent"
    assert label(OK, harness_error(UNSCOPED_KEY), {"last_status": None}) == "agent"


def test_an_answered_trial_is_never_relabelled_by_an_earlier_failed_call():
    answered = {"result": {"end_state": "answered", "end_detail": {}}}
    assert label(OK, answered, {"last_status": "400"}) == "agent"


def test_the_runner_report_schema_takes_config_error():
    example = json.loads((CONTRACT / "examples" / "runner-report-config-error.json").read_text())
    assert example["label"] == "infra:config_error"
    assert errors("runner-report", example) == []
    example["label"] = "infra:made_up"
    assert errors("runner-report", example) != []
