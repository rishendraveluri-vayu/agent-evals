"""Deterministic graders for agent-evals trials (SP4).

A grader reads a trial's out/ folder (result.json, trace.jsonl, checks.json) and returns a
grade with quoted evidence. Adapters never judge (R10.2); grading is its own step after the
trial (R14), so a grader fix re-grades old trials without re-running them.

The grader spec format is a draft for Rishi: docs/proposals/grader-format.md.
"""

# Part of every grader version: bump it when a change to this framework can change a verdict,
# so the new grades are stored next to the old ones instead of looking like the same grader.
FRAMEWORK_VERSION = "0.7.0"
# 0.7.0 (6 Nov, the destructive review's section G): a number grader may need context words next
# to the number (G1); the money reader reads what the runner's does (a no-break space or bold after
# ₹, ₹-5,000, ₹49.41L, million) and caps digit runs at 30 (G10, G6); the judge's material wraps
# each message and tool call in an escaped element, and its instructions say that text is
# evidence, never instructions (G5), so a judgment made before 0.7.0 saw a different input.
# 0.6.0: provenance on D61's checks.json (verify, don't trace); its reason and evidence name the
# figures derived in prose, and a pre-D61 file says so. 0.5.0: provenance on checks.json from
# runner 0.3.0 (D58: unit facts, the identity guard, reference_rates). 0.4.0: provenance traces
# arithmetic inputs (D56). 0.3.0: the judge runs (when approved). 0.2.0: real checks.json.

__all__ = ["FRAMEWORK_VERSION"]
