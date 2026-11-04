"""Hermes's own prompt and request switches that follow our settings, against the fake model.

- D33: Hermes's "Parallel tool calls" prompt section follows `parallel_tool_calls`: off when it is
  false, Hermes's default (on) when it is true or unset. Every other section stays (D20).
- D31: prompt-cache markers are off in every Hermes config unless the `prompt_cache_markers`
  harness option turns them on.

Each test reads what reached the fake: the system message of the first agent request.
"""

import hashlib
import json
import socket

import pytest
from evals_adapter.gate import GATE_SYSTEM_PROMPT, FakeServer
from test_gate import GATE, HERMES_PY

pytestmark = pytest.mark.skipif(not HERMES_PY.exists(), reason="no Hermes env")

PARALLEL_HEADING = "# Parallel tool calls"
FINISHING_HEADING = "# Finishing the job"  # another of Hermes's guidance sections, kept (D20)
LITELLM_HOST = "litellm.localhost"


@pytest.fixture(scope="module")
def fake():
    server = FakeServer()
    yield server
    server.stop()


def text_of(content):
    if isinstance(content, str):
        return content
    return "".join(p.get("text", "") for p in content if isinstance(p, dict))


def system_message(run) -> str:
    first = GATE.agent_requests(run)[0]["body"]["messages"][0]
    assert first["role"] == "system", first["role"]
    return text_of(first["content"])


def run_with(tmp_path, fake, **settings):
    spec = GATE.spec(tmp_path / "trial", "finance-emi", fake, **settings)
    if settings.get("parallel_tool_calls", False) is None:
        spec["settings_sources"]["parallel_tool_calls"] = "harness_default"
    run = GATE.run(tmp_path, fake, spec)
    GATE.check_schemas(run)
    assert run.result["end_state"] == "answered", run.explain()
    return run


# ---- D33 ---------------------------------------------------------------------------------------


def test_parallel_section_is_off_when_parallel_tool_calls_is_false(tmp_path, fake):
    run = run_with(tmp_path, fake, parallel_tool_calls=False)
    prompt = system_message(run)
    assert PARALLEL_HEADING not in prompt
    assert "batch them" not in prompt
    assert FINISHING_HEADING in prompt, "only the parallel section may go (D20)"
    assert GATE_SYSTEM_PROMPT in prompt
    # The rendered prompt Hermes kept agrees with the wire.
    saved = (run.trial_dir / "out" / "artifacts" / "hermes-system-prompt.txt").read_text()
    assert PARALLEL_HEADING not in saved
    applied = run.result["applied_settings"]["parallel_tool_call_guidance"]
    assert applied["value"] is False and applied["source"] == "config", applied
    assert GATE.agent_requests(run)[0]["body"]["parallel_tool_calls"] is False


@pytest.mark.parametrize("value", [True, None], ids=["true", "unset"])
def test_parallel_section_stays_when_parallel_tool_calls_is_true_or_unset(tmp_path, fake, value):
    run = run_with(tmp_path, fake, parallel_tool_calls=value)
    prompt = system_message(run)
    assert PARALLEL_HEADING in prompt
    assert FINISHING_HEADING in prompt
    applied = run.result["applied_settings"]["parallel_tool_call_guidance"]
    expected_source = "config" if value is not None else "harness_default"
    assert applied["value"] is True and applied["source"] == expected_source, applied


# ---- D31 ---------------------------------------------------------------------------------------


def _resolves_to_loopback(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, 80, proto=socket.IPPROTO_TCP)
    except OSError:
        return False
    return any(info[4][0] in ("127.0.0.1", "::1") for info in infos)


def claude_on_litellm_spec(tmp_path, fake, harness_options):
    """The one case where Hermes adds cache markers: a model name with "claude" on a host whose
    name has the token "litellm". The fake picks the script from a marker in the prompt."""
    spec = GATE.spec(tmp_path / "trial", "finance-emi", fake)
    text = GATE_SYSTEM_PROMPT + " [[fake-script:finance-emi]]"
    spec["system_prompt"] = {
        "id": "gate",
        "version": "gate-1-marker",
        "sha256": hashlib.sha256(text.encode()).hexdigest(),
        "text": text,
    }
    spec["model"]["name"] = "fake/claude-haiku-5-5"
    spec["model"]["base_url"] = f"http://{LITELLM_HOST}:{fake.port}/v1"
    spec["harness_options"] = harness_options
    return spec


def requests_text(run) -> str:
    return json.dumps([r["body"] for r in GATE.agent_requests(run)])


def test_no_cache_markers_by_default(tmp_path, fake):
    run = run_with(tmp_path, fake)
    assert "cache_control" not in requests_text(run)
    applied = run.result["applied_settings"]["prompt_cache_markers"]
    assert applied == {
        "value": False,
        "source": "platform_default",
        "observed": applied["observed"],
    }
    assert run.result["harness"]["extra"]["prompt_cache_markers"] is False


@pytest.mark.skipif(
    not _resolves_to_loopback(LITELLM_HOST), reason=f"{LITELLM_HOST} does not resolve here"
)
@pytest.mark.parametrize(
    ("options", "markers"),
    [({}, False), ({"prompt_cache_markers": False}, False), ({"prompt_cache_markers": True}, True)],
    ids=["default", "off", "on"],
)
def test_cache_markers_only_when_the_option_turns_them_on(tmp_path, fake, options, markers):
    """A claude model on a host named litellm is the case where Hermes would add the markers.
    The "on" case is the positive control: it shows this test can see them."""
    run = GATE.run(tmp_path, fake, claude_on_litellm_spec(tmp_path, fake, options))
    GATE.check_schemas(run)
    assert run.result["end_state"] == "answered", run.explain()
    assert ("cache_control" in requests_text(run)) is markers
    applied = run.result["applied_settings"]["prompt_cache_markers"]
    assert applied["value"] is markers
    assert applied["source"] == ("config" if options else "platform_default")
