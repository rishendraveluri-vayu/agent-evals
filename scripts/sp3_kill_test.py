"""SP3 done-when: kill a worker mid-run, restart it, and check that no trial is lost,
duplicated or mislabelled. Fake models only (fake/* through LiteLLM): no spend.

Needs the full stack up (`docker compose up -d --build --wait`), with the worker services.

    python3 scripts/sp3_kill_test.py [--api http://127.0.0.1:3001/api] [--n 10]

What it does: creates two configs (own loop and LangGraph, both on fake/finance-emi), one
experiment with the engine-smoke task x 2 configs x N, starts it, waits until the own-loop
worker is running a trial, `docker kill`s that worker container, restarts it with
`docker compose up -d worker-ownloop`, waits for the experiment to drain, then checks:
- every (config, repeat) slot has exactly one `done` attempt, labelled `agent`;
- no slot has more than 2 attempts (D16: re-queued once, never twice);
- every attempt that is not `done` is `abandoned` or `infra_failed` and was followed by
  exactly one later attempt;
- every done trial has its files stored with the API.
Exits 1 on any failure.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict


def call(api: str, method: str, path: str, body: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        api + path, data=data, method=method, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as err:
        raise SystemExit(f"{method} {path} -> {err.code}: {err.read()[:800]!r}") from None


def by_id(items: list[dict], key: str, value: str) -> dict:
    for item in items:
        if item.get(key) == value:
            return item
    raise SystemExit(f"no {key}={value} in {[i.get(key) for i in items]}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:3001/api")
    ap.add_argument("--n", type=int, default=10)
    ap.add_argument("--check", help="only check an existing experiment id (after it drains)")
    args = ap.parse_args()
    api = args.api.rstrip("/")

    if args.check:
        return check(api, args.check, args.n, None)
    prompt = by_id(call(api, "GET", "/prompts"), "id", "finance-advisor")
    toolset = call(api, "GET", "/toolsets")[0]
    task = by_id(call(api, "GET", "/tasks"), "id", "engine-smoke-emi")
    configs = []
    for harness in ("ownloop", "langgraph"):
        cfg = call(api, "POST", "/configs", {
            "name": f"engine test, {harness}, fake",
            "harness": harness,
            "model": "fake/finance-emi",
            "prompt_sha256": prompt["sha256"],
            "toolset_sha256": toolset["sha256"],
            "settings": {"max_steps": 10, "timeout_s": 60},
        })
        configs.append(cfg)
    exp = call(api, "POST", "/experiments", {
        "name": "SP3 kill test (fake models)",
        "axis": "harness",
        "config_hashes": [c["hash"] for c in configs],
        "task_sha256s": [task["sha256"]],
        "n": args.n,
        "budget_usd": 5.0,  # fake-model prices; the API refuses budgets below its estimate
    })
    eid = exp["id"]
    call(api, "POST", f"/experiments/{eid}/start")
    print(f"experiment {eid}: {2 * args.n} trials, started")

    # Wait for the own-loop worker to be mid-trial, then kill it.
    deadline = time.time() + 300
    while time.time() < deadline:
        rows = call(api, "GET", f"/experiments/{eid}/trials")
        running = [t for t in rows if t["status"] in ("claimed", "running")]
        if any(t["harness"] == "ownloop" for t in running):
            time.sleep(2)  # let the adapter get well into the trial before the kill
            break
        time.sleep(0.3)
    else:
        raise SystemExit("the own-loop worker never started a trial")
    victim = next(t for t in running if t["harness"] == "ownloop")
    name = subprocess.run(
        ["docker", "compose", "ps", "-q", "worker-ownloop"], capture_output=True, text=True,
        check=True,
    ).stdout.strip()
    subprocess.run(["docker", "kill", name], check=True, capture_output=True)
    print(f"killed worker-ownloop while it ran trial {victim['id']} (attempt {victim['attempt']})")
    time.sleep(3)
    # Restart the same container. Not `docker compose up`: without the caller's port overrides
    # (API_PORT and so on) compose would recreate the API on its default port mid-run.
    subprocess.run(["docker", "start", name], check=True, capture_output=True)
    print("restarted worker-ownloop")

    return check(api, eid, args.n, victim)


def check(api: str, eid: str, n: int, victim: dict | None) -> int:
    deadline = time.time() + 900
    while time.time() < deadline:
        counts = call(api, "GET", f"/experiments/{eid}")["counts"]
        if counts["queued"] == 0 and counts["running"] == 0:
            break
        time.sleep(3)
    else:
        raise SystemExit(f"experiment did not drain: {counts}")
    print("drained:", json.dumps(counts))

    rows = call(api, "GET", f"/experiments/{eid}/trials")
    slots = defaultdict(list)
    for t in rows:
        slots[(t["config_hash"], t["repeat_index"])].append(t)
    failures = []
    if len(slots) != 2 * n:
        failures.append(f"{len(slots)} slots, expected {2 * n}")
    for key, attempts in sorted(slots.items()):
        attempts.sort(key=lambda t: t["attempt"])
        done = [t for t in attempts if t["status"] == "done"]
        if len(done) != 1:
            failures.append(f"slot {key}: {len(done)} done attempts")
        elif done[0]["label"] != "agent":
            failures.append(f"slot {key}: done attempt labelled {done[0]['label']}")
        if len(attempts) > 2:
            failures.append(f"slot {key}: {len(attempts)} attempts, cap is 2")
        for earlier in attempts[:-1]:
            if earlier["status"] not in ("abandoned", "infra_failed"):
                failures.append(f"slot {key}: attempt {earlier['attempt']} is {earlier['status']}")
    if victim is not None:
        killed = slots.get((victim["config_hash"], victim["repeat_index"]), [])
        print("killed slot attempts:", [(t["attempt"], t["status"], t["label"]) for t in killed])
        if not any(t["status"] == "abandoned" for t in killed):
            failures.append("the killed attempt was not marked abandoned")
    retried = {k: [(t["attempt"], t["status"]) for t in v] for k, v in slots.items() if len(v) > 1}
    print("slots with more than one attempt:", retried or "none")
    for t in rows:
        if t["status"] == "done":
            detail = call(api, "GET", f"/trials/{t['id']}")
            if not detail.get("files"):
                failures.append(f"trial {t['id']}: no stored files")
    if failures:
        print("FAIL")
        for f in failures:
            print(" -", f)
        return 1
    print(f"PASS: {2 * n} slots, each done exactly once and labelled agent; "
          f"no slot over 2 attempts; every done trial has its files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
