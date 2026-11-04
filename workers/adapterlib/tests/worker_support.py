"""Helpers for the worker tests: specs for claims, spend rows placed inside an agent turn, and a
look at which processes are still alive."""

from __future__ import annotations

import datetime as dt
import json
import os
import sys
from pathlib import Path
from typing import Any

from support import FIXTURES, make_spec

from evals_adapter.fake_api import spend_row

EXPERIMENT = "e_test"
LEAK_CMD = [sys.executable, str(FIXTURES / "leak_probe.py")]
TRIAL_PLACES = ["trial_root", "home", "tmp", "harness", "state", "artifacts", "cwd"]
CONTAINER_PLACES = [*TRIAL_PLACES, "dev_shm", "slash_tmp", "var_tmp", "opt", "root", "runs"]


def worker_spec(trial_id: str = "t_test_0001", attempt: int = 1, **changes: Any) -> dict:
    spec = make_spec(**changes)
    spec["trial"].update({"id": trial_id, "attempt": attempt, "experiment_id": EXPERIMENT})
    return spec


def iso(ns: int) -> str:
    """Exact to the microsecond: a float timestamp can round a time out of a short turn."""
    whole = dt.datetime.fromtimestamp(ns // 1_000_000_000, dt.UTC)
    return whole.replace(microsecond=(ns // 1000) % 1_000_000).isoformat()


def turn_window(trial_root: Path) -> tuple[int, int]:
    """The first agent turn's start and end, from the trace the adapter left in the folder."""
    for line in (trial_root / "out" / "trace.jsonl").read_text().splitlines():
        span = json.loads(line)
        if span["name"] == "agent.turn":
            return int(span["startTimeUnixNano"]), int(span["endTimeUnixNano"])
    raise AssertionError("no agent.turn span yet")


def rows_in_turn(trial_root: Path, n: int = 2, spends: list[float] | None = None) -> list[dict]:
    """`n` LiteLLM spend rows timed inside the first agent turn, as LiteLLM would log the
    agent's calls during it. Times are whole microseconds, as LiteLLM writes them."""
    start, end = turn_window(trial_root)
    # At least 1 us inside both ends: proxy.iso_to_ns goes through a float and can be off by a
    # few hundred nanoseconds.
    lo, hi = start // 1000 + 2, end // 1000 - 1
    assert hi >= lo, f"agent turn too short to place calls in: {end - start} ns"
    rows = []
    for i in range(n):
        t_us = lo + (hi - lo) * (i + 1) // (n + 1)
        stamp = iso(t_us * 1000)
        spend = spends[i] if spends else 0.000034
        rows.append(spend_row(i + 1, stamp, stamp, spend=spend))
    return rows


def pids_with_env(entry: str) -> list[int]:
    """Live processes whose environment holds `entry` (NAME=value)."""
    found = []
    want = entry.encode()
    for name in os.listdir("/proc"):
        if not name.isdigit() or int(name) == os.getpid():
            continue
        try:
            env = Path(f"/proc/{name}/environ").read_bytes().split(b"\0")
            state = Path(f"/proc/{name}/stat").read_text().rsplit(")", 1)[1].split()[0]
        except OSError:
            continue
        if want in env and state != "Z":
            found.append(int(name))
    return found


def alive(pid: int) -> bool:
    try:
        state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
    except OSError:
        return False
    return state != "Z"
