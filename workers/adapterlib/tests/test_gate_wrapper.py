"""The tool test's declared description wrapper: only that exact text comes off."""

from evals_adapter.gate import unwrap_description, unwrap_schema_descriptions

WRAP = ("<<<BEGIN>>>\n", "\n<<<END>>>")


def test_only_the_exact_wrapper_comes_off():
    assert unwrap_description("<<<BEGIN>>>\nLoan EMI.\n<<<END>>>", WRAP) == "Loan EMI."
    # Anything else is left as sent, so it fails the comparison with the server's text.
    for text in ("Loan EMI.", "<<<BEGIN>>>Loan EMI.<<<END>>>", "<<<BEGIN>>>\nLoan EMI.", ""):
        assert unwrap_description(text, WRAP) == text
    assert unwrap_description("<<<BEGIN>>>\nLoan EMI.\n<<<END>>>", None).startswith("<<<BEGIN")
    assert unwrap_description(None, WRAP) is None


def test_schema_descriptions_unwrapped_and_nothing_else_touched():
    sent = {
        "type": "object",
        "properties": {
            "principal": {"type": "number", "description": "<<<BEGIN>>>\nRupees.\n<<<END>>>"},
            # A property called "description" is a schema, not text: only its own description
            # string is unwrapped.
            "description": {"type": "string", "description": "<<<BEGIN>>>\nA note.\n<<<END>>>"},
            "mode": {"enum": ["<<<BEGIN>>>\nx\n<<<END>>>"], "default": "a"},
        },
        "required": ["principal"],
    }
    assert unwrap_schema_descriptions(sent, WRAP) == {
        "type": "object",
        "properties": {
            "principal": {"type": "number", "description": "Rupees."},
            "description": {"type": "string", "description": "A note."},
            "mode": {"enum": ["<<<BEGIN>>>\nx\n<<<END>>>"], "default": "a"},
        },
        "required": ["principal"],
    }
    assert unwrap_schema_descriptions(sent, None) == sent
