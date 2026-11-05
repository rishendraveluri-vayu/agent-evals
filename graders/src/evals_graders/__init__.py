"""Deterministic graders for agent-evals trials (SP4).

A grader reads a trial's out/ folder (result.json, trace.jsonl, checks.json) and returns a
grade with quoted evidence. Adapters never judge (R10.2); grading is its own step after the
trial (R14), so a grader fix re-grades old trials without re-running them.

The grader spec format is a draft for Rishi: docs/proposals/grader-format.md.
"""

# Part of every grader version: bump it when a change to this framework can change a verdict,
# so the new grades are stored next to the old ones instead of looking like the same grader.
FRAMEWORK_VERSION = "0.6.0"
# 0.6.0: provenance on D61's checks.json (verify, don't trace); its reason and evidence name the
# figures derived in prose, and a pre-D61 file says so. 0.5.0: provenance on checks.json from
# runner 0.3.0 (D58: unit facts, the identity guard, reference_rates). 0.4.0: provenance traces
# arithmetic inputs (D56). 0.3.0: the judge runs (when approved). 0.2.0: real checks.json.

__all__ = ["FRAMEWORK_VERSION"]
