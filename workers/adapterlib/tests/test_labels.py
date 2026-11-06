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
    assert label(OK, harness_error(CONNECTION_REFUSED, "adapter_exception"), None) == "agent"


# The shapes a harness reports when LiteLLM is not reachable (E1, 6 Nov review: LiteLLM taken off
# the trials network). The openai client, as the own loop, LangGraph and the Agents SDK raise it:
CONNECTION_REFUSED = "Connection error."
HTTPX_REFUSED = "[Errno 111] Connection refused"
UNRESOLVED = "litellm.APIConnectionError: [Errno -3] Temporary failure in name resolution"


def unreachable(message: str, kind: str = "APIConnectionError") -> dict:
    checked = harness_error(message, f"model call failed: {kind}")
    checked["result"]["end_detail"]["exception_type"] = kind
    return checked


@pytest.mark.parametrize(
    "checked",
    [
        unreachable(CONNECTION_REFUSED),
        unreachable(HTTPX_REFUSED, "ConnectError"),
        unreachable(UNRESOLVED),
        harness_error(None, "adapter_exception"),
    ],
)
def test_no_call_reached_litellm_is_a_provider_error_not_the_agents(checked):
    """E1: LiteLLM's record exists but holds no call (the runner read it: last_status None,
    model_calls 0). No request reached the model, so whatever the harness said, the agent did not
    cause it: infra:provider_error, which the API re-queues once like any provider error."""
    usage = {"last_status": None, "model_calls": 0, "complete": True}
    assert label(OK, checked, usage) == "infra:provider_error"
    assert provider_label(None, checked["result"], proxy_seen=True) == "infra:provider_error"
    assert provider_label(None, checked["result"]) is None


def test_litellm_lost_after_a_logged_call_is_a_provider_error():
    """E1: the earlier calls were logged (last_status 200), then LiteLLM went away: the call that
    failed never reached it, so it was never logged. The adapter's error says so."""
    for message, kind in (
        (CONNECTION_REFUSED, "APIConnectionError"),
        (HTTPX_REFUSED, "ConnectError"),
    ):
        checked = unreachable(message, kind)
        assert label(OK, checked, {"last_status": "200"}) == "infra:provider_error"
    # Any other harness error after a successful call stays the agent's, as before.
    assert (
        label(OK, harness_error(OTHER_400, "adapter_exception"), {"last_status": "200"}) == "agent"
    )
    assert label(OK, unreachable(CONNECTION_REFUSED), None) == "agent"


def test_an_answered_trial_is_never_relabelled_by_an_earlier_failed_call():
    answered = {"result": {"end_state": "answered", "end_detail": {}}}
    assert label(OK, answered, {"last_status": "400"}) == "agent"


def test_the_runner_report_schema_takes_config_error():
    example = json.loads((CONTRACT / "examples" / "runner-report-config-error.json").read_text())
    assert example["label"] == "infra:config_error"
    assert errors("runner-report", example) == []
    example["label"] = "infra:made_up"
    assert errors("runner-report", example) != []


def sim_error(stop_reason: str = "simulator_error") -> dict:
    checked = harness_error("simulator reply has no text (finish_reason length)", stop_reason)
    checked["result"]["conversation"] = {"ended_by": "sim_error"}
    return checked


@pytest.mark.parametrize("status", [None, "200", "400", "429", "budget_exceeded"])
def test_a_simulator_failure_is_sim_error_whatever_the_agent_keys_status(status):
    """D26: the agent did not cause it, and the agent key's status is not the simulator's."""
    usage = None if status is None else {"last_status": status}
    assert label(OK, sim_error(), usage) == "infra:sim_error"


def test_the_simulators_own_budget_stop_is_budget_net_not_sim_error():
    """D26: budget stops are never re-queued; sim_error is re-queued once, so the simulator's
    key running out must not be labelled sim_error. Seen either in LiteLLM's record for the
    simulator key or in the refusal the simulator got back."""
    assert label(OK, sim_error(), None, sim_last_status="budget_exceeded") == "infra:budget_net"
    refused = harness_error(
        'simulator call failed: HTTP 400: {"error": {"message": "Budget has been'
        ' exceeded! Current cost: 0.1002, Max budget: 0.1"}}',
        "simulator_error",
    )
    refused["result"]["conversation"] = {"ended_by": "sim_error"}
    assert label(OK, refused, {"last_status": "200"}) == "infra:budget_net"
    for status in (None, "200", "429", "500"):
        assert label(OK, sim_error(), None, sim_last_status=status) == "infra:sim_error"


def test_sim_error_does_not_hide_a_kill_or_a_crash():
    killed = {"signal": "SIGKILL", "exit_code": None}
    assert label(killed, sim_error(), None) == "infra:timeout_kill"
    assert label({"signal": None, "exit_code": 3}, sim_error(), None) == "infra:adapter_crash"


def test_a_conversation_that_ended_any_other_way_is_not_sim_error():
    for ended_by in (None, "client", "turn_cap", "agent_end_state"):
        checked = harness_error(None, "adapter_exception")
        checked["result"]["conversation"] = {"ended_by": ended_by}
        assert label(OK, checked, {"last_status": "200"}) == "agent"


def test_the_runner_report_schema_takes_sim_error():
    example = json.loads((CONTRACT / "examples" / "runner-report-sim-error.json").read_text())
    assert example["label"] == "infra:sim_error"
    assert errors("runner-report", example) == []
    result = json.loads((CONTRACT / "examples" / "result-sim-error.json").read_text())
    assert result["conversation"]["ended_by"] == "sim_error"
    assert errors("result", result) == []
    assert label(OK, {"result": result}, example["proxy_usage"]) == "infra:sim_error"
