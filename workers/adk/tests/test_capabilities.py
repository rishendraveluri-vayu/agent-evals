"""capabilities.json must match what a fresh probe sees (R11: generated from evidence)."""

from evals_adapter.probe import probe
from test_gate import CAPS_FILE, GATE

PROBED = ("temperature", "max_output_tokens", "max_steps", "parallel_tool_calls")
FIELDS = ("supported", "default", "extra_calls_at_limit", "observed")


def test_capabilities_match_a_fresh_probe():
    fresh = probe(CAPS_FILE, GATE.adapter_cmd, GATE.env, GATE.tool_name(""))
    for name in PROBED:
        for field in FIELDS:
            assert fresh["settings"][name].get(field) == GATE.capabilities["settings"][name].get(
                field
            ), f"{name}.{field} changed: run ./probe.sh and review the diff"
