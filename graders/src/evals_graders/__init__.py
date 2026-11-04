"""Deterministic graders for agent-evals trials (SP4).

A grader reads a trial's out/ folder (result.json, trace.jsonl, checks.json) and returns a
grade with quoted evidence. Adapters never judge (R10.2); grading is its own step after the
trial (R14), so a grader fix re-grades old trials without re-running them.

The grader spec format is a draft for Rishi: docs/proposals/grader-format.md.
"""

# Part of every grader version: bump it when a change to this framework can change a verdict,
# so the new grades are stored next to the old ones instead of looking like the same grader.
FRAMEWORK_VERSION = "0.1.0"

__all__ = ["FRAMEWORK_VERSION"]
