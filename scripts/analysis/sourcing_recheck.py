#!/usr/bin/env python3
"""Re-run the runner's sourcing check on a shipped experiment's stored trials, two ways.

Strict is the check as shipped. Lenient turns on `DERIVE_COARSE` in
`workers/adapterlib/src/evals_adapter/checks.py`: a figure derived in prose may then match after
the same coarse rounding a sourced figure already gets (trailing zeros, within 1%). Writes one
JSON row per trial for `sourcing_compare.py`. No model calls.

Run it from `workers/adapterlib`, which provides `evals_adapter`:

    uv run python -I ../../scripts/analysis/sourcing_recheck.py \
        ../../examples/<example> ../../runs/<experiment id> out.json
"""

import gzip
import json
import sys
from pathlib import Path

from evals_adapter import checks


def latest_jobs(jobs):
    """Each trial's most recent finished grading job."""
    out = {}
    for job in jobs:
        if job.get("passed") is None:
            continue
        prev = out.get(job["trial_id"])
        if prev is None or (job.get("reported_at") or "") > (prev.get("reported_at") or ""):
            out[job["trial_id"]] = job
    return out


def client_files(task):
    """The task's client file, as the worker gave it to the trial."""
    raw = task.get("client_state")
    if not raw:
        return {}
    text = bytes.fromhex(raw[2:]).decode("utf-8") if raw.startswith("\\x") else raw
    return {task.get("client_state_name") or "client.json": text}


def main(example, runs, out):
    with gzip.open(example / "rows.json.gz") as f:
        tables = json.load(f)["tables"]
    tasks = {t["sha256"]: t for t in tables["tasks"]}
    jobs = latest_jobs(tables["grading_jobs"])
    grades = {}
    for g in tables["grades"]:
        grades.setdefault(g["job_id"], []).append(g)

    rows = []
    for trial in tables["trials"]:
        if trial["status"] != "done" or trial["id"] not in jobs:
            continue
        folder = sorted((runs / trial["id"]).glob("attempt-*"))[-1]
        spec = trial["spec"]
        task = tasks[spec["trial"]["task_version"]]
        result = json.loads((folder / "result.json").read_text())
        spans = checks.read_spans(folder / "trace.jsonl")
        unsupported = {}
        for lenient in (False, True):
            checks.DERIVE_COARSE = lenient
            found = checks.run_checks(spec, result, spans, client_files(task))
            unsupported[lenient] = found["unsupported"]
        shipped = json.loads((folder / "checks.json").read_text())["unsupported"]
        job = jobs[trial["id"]]
        required = [g for g in grades.get(job["id"], []) if g["required"]]
        sourcing = [g for g in required if g["type"] == "provenance"]
        rows.append(
            {
                "trial": trial["id"],
                "config": trial["config_hash"],
                "task": task["id"],
                "shipped_unsupported": shipped,
                "strict_unsupported": unsupported[False],
                "lenient_unsupported": unsupported[True],
                "shipped_pass": bool(job["passed"]),
                "has_provenance": bool(sourcing),
                "prov_shipped_pass": all(g["verdict"] == "pass" for g in sourcing),
                "others_pass": all(g["verdict"] == "pass" for g in required if g not in sourcing),
            }
        )
    with open(out, "w") as f:
        json.dump(rows, f, indent=0)
    differ = sum(r["shipped_unsupported"] != r["strict_unsupported"] for r in rows)
    fewer = sum(r["lenient_unsupported"] < r["strict_unsupported"] for r in rows)
    print(f"{len(rows)} trials; {differ} strict re-runs differ from the shipped checks.json;")
    print(f"{fewer} trials have fewer unsupported figures under lenient")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
