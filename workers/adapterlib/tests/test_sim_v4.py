"""client-sim v4: v3 plus patience (Rishi's review note 16, platform item 9). Text checks only:
the fake simulator ignores the prompt, so whether a real model follows it is unknown until real
v4 transcripts are read."""

from __future__ import annotations

from support import REPO, client_sim

from evals_adapter.gate import prompt_text
from evals_adapter.sim import END_MARKER, render_prompt

PROMPTS = REPO / "configs" / "prompts"
V3 = prompt_text(PROMPTS / "client-sim.v3.md")
V4 = prompt_text(PROMPTS / "client-sim.v4.md")
V3_LAST = (
    "If the advisor has not given a direct answer to your main concern, ask for it plainly "
    "instead of ending. Never write {{end_marker}} for any other reason."
)
V4_LAST = (
    "If the advisor has not given a direct answer to your main concern, ask for it plainly "
    "instead of ending, unless your patience has run out as described above. Never write "
    "{{end_marker}} for any other reason."
)


def test_v4_is_v3_plus_the_patience_section():
    """Every v3 line is in v4 unchanged, except the last one, which now allows the patience
    ending. Nothing else is added beyond the patience section."""
    assert V3_LAST in V3 and V4_LAST in V4
    v3_lines = [line for line in V3.replace(V3_LAST, V4_LAST).splitlines() if line.strip()]
    v4_lines = [line for line in V4.splitlines() if line.strip()]
    assert [line for line in v3_lines if line not in v4_lines] == []
    added = [line for line in v4_lines if line not in v3_lines]
    assert added[0] == "## Your patience"
    assert len(added) == 5, added


def test_v4_patience_rules():
    text = render_prompt(V4, client_sim("http://unused/v1"))
    assert "{{" not in text and "}}" not in text
    assert "After two replies in a row that give you nothing" in text
    assert "you want an answer to your main concern now" in text
    assert "If the very next reply also gives you nothing, end the conversation unhappy" in text
    assert "starts the count again" in text
    # The marker: the normal ending, the patience ending and the "never otherwise" rule.
    assert text.count(END_MARKER) == 3
    assert V3.count("{{end_marker}}") == 2
