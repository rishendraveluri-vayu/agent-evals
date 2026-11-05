"""Hermes's gate tests (contract v2 section 8), against the fake model server.

The adapter runs on Hermes's own environment. Point HERMES_SRC at a checkout of the pinned SHA
with `uv sync --locked --extra mcp` done (scripts/setup_hermes.sh does both); the tests skip
without one.
"""

import json
import os
import subprocess
from pathlib import Path

import pytest
from evals_adapter.gate import NO_CALCULATOR_TOOLS, FakeServer, Gate

HERE = Path(__file__).resolve().parents[1]
REPO = HERE.parents[1]
HERMES_SRC = Path(os.environ.get("HERMES_SRC", HERE / ".hermes-agent"))
HERMES_PY = HERMES_SRC / ".venv" / "bin" / "python"
PINNED = "6112c2adb9e11f69734a29be9d2696f345ffa06a"

pytestmark = pytest.mark.skipif(not HERMES_PY.exists(), reason=f"no Hermes env at {HERMES_SRC}")

CAPS_FILE = HERE / "src" / "hermes_adapter" / "capabilities.json"
CAPS = json.loads(CAPS_FILE.read_text())
GATE = Gate(
    harness="hermes",
    adapter_cmd=[str(HERMES_PY), "-m", "hermes_adapter.adapter"],
    capabilities=CAPS,
    tool_name=lambda name: f"mcp__finance__{name}",
    env={"PYTHONPATH": f"{HERE / 'src'}:{REPO / 'workers' / 'adapterlib' / 'src'}"},
)


@pytest.fixture(scope="module")
def fake():
    server = FakeServer()
    yield server
    server.stop()


def test_checkout_is_the_pinned_sha_and_clean():
    head = subprocess.run(
        ["git", "-C", str(HERMES_SRC), "rev-parse", "HEAD"], capture_output=True, text=True
    )
    assert head.stdout.strip() == PINNED
    dirty = subprocess.run(
        ["git", "-C", str(HERMES_SRC), "status", "--porcelain", "--untracked-files=no"],
        capture_output=True,
        text=True,
    )
    assert dirty.stdout.strip() == ""


def test_answer(tmp_path, fake):
    GATE.test_answer(tmp_path, fake)


def test_settings(tmp_path, fake):
    GATE.test_settings(tmp_path, fake)


def test_unset_not_sent(tmp_path, fake):
    GATE.test_unset_not_sent(tmp_path, fake)


def test_steps(tmp_path, fake):
    GATE.test_steps(tmp_path, fake)


def test_tools(tmp_path, fake):
    GATE.test_tools(tmp_path, fake)


def test_tools_without_calculators(tmp_path, fake):
    """D70's finance-no-calculators: only its 11 tools reach the model (`tools.include`)."""
    GATE.test_tools(tmp_path, fake, NO_CALCULATOR_TOOLS, "finance-no-calculators")


def test_timeout(tmp_path, fake):
    GATE.test_timeout(tmp_path, fake)


def test_malformed_tool_call(tmp_path, fake):
    GATE.test_malformed_tool_call(tmp_path, fake)


def test_no_harness_retries(tmp_path, fake):
    GATE.test_no_harness_retries(tmp_path, fake)


def test_conversation(tmp_path, fake):
    GATE.test_conversation(tmp_path, fake)


# ---- Memory and skills in the trace (contract v2 section 7, brief item 6) ------------------

SEEDED = "The client is Asha; her salary arrives on the 1st. (gate fixture)"
SKILL = {
    "name": "emi-playbook",
    "description": "How this firm answers EMI questions.",
    "body": "Compute the EMI with calculate_emi and state it to the rupee. (gate fixture)\n",
}


def trace_events(run, prefix):
    """(name, attributes) of every span event whose name starts with `prefix`, in time order."""
    found = []
    for span in run.spans:
        for event in span.get("events") or []:
            if event["name"].startswith(prefix):
                attrs = {
                    a["key"]: next(iter(a["value"].values())) for a in event.get("attributes", [])
                }
                found.append((int(event["timeUnixNano"]), event["name"], attrs))
    return [(name, attrs) for _, name, attrs in sorted(found, key=lambda e: e[0])]


def test_a_skill_load_is_traced(tmp_path, fake):
    spec = GATE.spec(tmp_path / "trial", "skill-view", fake, skills={"enabled": True})
    spec["seed"]["skills"] = [SKILL]
    run = GATE.run(tmp_path, fake, spec)
    assert run.result.get("end_state") == "answered", run.explain()
    assert trace_events(run, "evals.skill.") == [
        ("evals.skill.load", {"evals.skill.name": "emi-playbook"})
    ]
    # Hermes really loaded the seeded skill: its tool result carries the skill's body.
    [view] = run.spans_named("execute_tool skill_view")
    attrs = {a["key"]: a["value"] for a in view["attributes"]}
    result = attrs["evals.tool.result"]["stringValue"]
    assert "(gate fixture)" in result
    assert trace_events(run, "evals.memory.") == []


def test_memory_reads_and_writes_are_traced(tmp_path, fake):
    spec = GATE.spec(tmp_path / "trial", "memory-write", fake, memory={"enabled": True})
    spec["seed"]["memory"] = [SEEDED]
    run = GATE.run(tmp_path, fake, spec)
    assert run.result.get("end_state") == "answered", run.explain()
    assert trace_events(run, "evals.memory.") == [
        (
            "evals.memory.read",
            {
                "evals.memory.target": "memory",
                "evals.memory.entries": "1",
                "evals.memory.content": SEEDED,
            },
        ),
        (
            "evals.memory.write",
            {
                "evals.memory.target": "memory",
                "evals.memory.action": "add",
                "evals.memory.content": "Client prefers to keep EMIs under Rs 20,000 a month.",
            },
        ),
    ]
    # What the read event says is what reached the model: the seeded entry is in the prompt.
    system = GATE.agent_requests(run)[0]["body"]["messages"][0]["content"]
    assert "her salary arrives on the 1st" in system
    # And the write is real: Hermes saved the entry in its home.
    saved = (run.trial_dir / "harness" / "hermes" / "memories" / "MEMORY.md").read_text()
    assert "Client prefers to keep EMIs under Rs 20,000 a month." in saved


def test_memory_and_skills_off_leave_no_events(tmp_path, fake):
    run = GATE.run(tmp_path, fake, GATE.spec(tmp_path / "trial", "finance-emi", fake))
    assert run.result.get("end_state") == "answered", run.explain()
    assert trace_events(run, "evals.memory.") == trace_events(run, "evals.skill.") == []
