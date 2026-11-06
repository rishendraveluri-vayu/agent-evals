"""The adapter's tool-error flag (is_error on each tool span), without the Hermes env: the
function reads only the result text Hermes hands back.

Destructive review G12 (6 Nov): Hermes appends a loop warning after the JSON of a failing call
('{"error": ...}\\n\\n[Tool loop warning: ...]'), which is not JSON as a whole, so 7 error spans in
the positive control were marked is_error=false.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from hermes_adapter.adapter import is_error_result  # noqa: E402

WARNING = (
    "\n\n[Tool loop warning: same_tool_failure_warning; count=3; mcp__finance__multiply has failed"
    " 3 times this turn. This looks like a loop.]"
)


def test_an_error_object_followed_by_hermes_warning_is_an_error():
    text = (
        '{"error": "Error executing tool multiply: invalid arguments: values: List should have'
        ' at most 100 items after validation, not 114"}' + WARNING
    )
    assert is_error_result(text)
    assert is_error_result("  " + text)


def test_plain_errors_and_results():
    assert is_error_result('{"error": "boom"}')
    assert is_error_result({"error": "boom"})
    assert is_error_result("Error: the server is down")
    assert not is_error_result('{"result": 12}')
    assert not is_error_result('{"result": 12, "error": null}')
    assert not is_error_result('{"result": 12}' + WARNING)
    assert not is_error_result('{"emi": 8997.26}')
    assert not is_error_result("[1, 2, 3]" + WARNING)
    assert not is_error_result("All fine")
    assert not is_error_result("")
