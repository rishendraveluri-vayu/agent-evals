"""Tests for log_system_spend.py.

Run: python3 -m unittest discover -s scripts -p 'test_log_system_spend.py'
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from log_system_spend import END, START, merge  # noqa: E402

DOC = f"""# Cost

## System calls

{START}
| Date | Id | Kind | Model | Ref | Status | Input tok | Output tok | Cost | Source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
{END}

## Next section
"""

ROW = {
    "id": "ss_0mh1abc",
    "kind": "conflict_check",
    "model": "claude-sonnet-5-5",
    "status": "done",
    "cost_usd": 0.0123,
    "cost_source": "spend_log",
    "input_tokens": 3000,
    "output_tokens": 400,
    "ref": "config:sha256:" + "ab" * 32,
    "created_at": "2026-11-04T18:00:00.000Z",
}


class MergeTest(unittest.TestCase):
    def test_appends_a_settled_call_inside_the_block(self):
        text, added = merge(DOC, [ROW])
        self.assertEqual(
            added,
            [
                "| 2026-11-04 | `ss_0mh1abc` | conflict_check | claude-sonnet-5-5 "
                "| config abababababab | done | 3,000 | 400 | $0.0123 | spend_log |"
            ],
        )
        self.assertIn(added[0] + "\n" + END, text)
        self.assertTrue(text.endswith("## Next section\n"))

    def test_is_idempotent_and_skips_pending_calls(self):
        once, _ = merge(DOC, [ROW])
        twice, added = merge(
            once, [ROW, {**ROW, "id": "ss_pending", "status": "pending", "cost_usd": None}]
        )
        self.assertEqual(added, [])
        self.assertEqual(twice, once)

    def test_writes_unknown_for_a_cost_never_reported(self):
        _, added = merge(
            DOC, [{**ROW, "status": "failed", "cost_usd": None, "cost_source": "unknown"}]
        )
        self.assertIn("| failed | 3,000 | 400 | unknown | unknown |", added[0])

    def test_refuses_a_file_without_the_block(self):
        with self.assertRaises(ValueError):
            merge("# Cost\n", [ROW])


if __name__ == "__main__":
    unittest.main()
