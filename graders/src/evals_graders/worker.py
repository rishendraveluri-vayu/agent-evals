"""`evals-grader`: the grading worker. Grading is its own step after the trial (R14).

The loop, over HTTP only (D2), with the worker token:

1. Claim: POST /grader/claim. 204 means nothing needs grading: back off with jitter. A claim is a
   grading job: one trial, the task's grader specs frozen when the job was queued (with the API's
   hash of each), any grader files (a unit_test's grader.py) and the trial's file manifest.
2. Download: GET /trials/:id/files/<path> for result.json, trace.jsonl, runner-report.json and
   checks.json when the manifest lists them, each checked against the manifest's sha256. Nothing
   is mounted from the host.
3. Grade: the same code as `evals-grade` (graders.grade_trial), in a fresh temporary folder. A
   judge grader calls a model only when the claim carries `judge` (the experiment's judging was
   approved with a model and a budget, and the API minted a key for it), and its rubric comes in
   `grader_files` under its configs/rubrics/ path.
4. Report: POST /grader/trials/:id/grades with every grade. Retried on network errors and 5xx;
   the API treats a repeat of the same job and claim as a no-op. A 409 means the lease lapsed and
   another worker holds the job: drop it.

A file that cannot be downloaded is not graded around: the job is dropped unreported, its lease
lapses and it is claimed again (the API caps claims and then marks the job failed). A file whose
bytes differ from the manifest is reported as `error` grades, since claiming again cannot fix it.

Config from the environment: EVALS_API_URL (with /api), EVALS_WORKER_TOKEN, EVALS_GRADER_ID
(default grader-<hostname>).
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import random
import socket
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath
from typing import Any

from evals_graders import FRAMEWORK_VERSION
from evals_graders.graders import grade_trial
from evals_graders.judge import RUBRIC_PATH, JudgeAccess, Transport

WANTED = ("result.json", "trace.jsonl", "runner-report.json", "checks.json")
MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024


def log(message: str) -> None:
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    print(f"[evals-grader] {stamp} {message}", file=sys.stderr, flush=True)


class NetworkError(RuntimeError):
    """The API could not be reached. Worth retrying."""


class ApiError(RuntimeError):
    def __init__(self, what: str, status: int, body: Any) -> None:
        self.status = status
        self.code = body.get("error") if isinstance(body, dict) else None
        super().__init__(f"{what}: HTTP {status}: {str(body)[:300]}")

    @property
    def retryable(self) -> bool:
        return self.status >= 500 or self.status == 429


class FileUnavailable(RuntimeError):
    """A trial file could not be fetched now; the lease will lapse and the job is claimed again."""


class GraderApi:
    def __init__(self, base_url: str, token: str, timeout_s: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout_s = timeout_s

    def _request(self, method: str, path: str, body: Any = None) -> tuple[int, bytes]:
        data = None if body is None else json.dumps(body).encode()
        headers = {"Authorization": f"Bearer {self.token}", "Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(
            self.base_url + path, data=data, headers=headers, method=method
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:  # noqa: S310
                return resp.status, resp.read(MAX_DOWNLOAD_BYTES + 1)
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read(64 * 1024)
        except (urllib.error.URLError, OSError) as exc:
            raise NetworkError(f"{method} {path}: {exc!r}") from exc

    @staticmethod
    def _json(raw: bytes) -> Any:
        try:
            return json.loads(raw.decode("utf-8")) if raw else None
        except (UnicodeDecodeError, ValueError):
            return raw[:300].decode("utf-8", "replace")

    def claim(self, worker_id: str) -> dict[str, Any] | None:
        status, raw = self._request("POST", "/grader/claim", {"worker_id": worker_id})
        if status == 204:
            return None
        body = self._json(raw)
        if status == 200 and isinstance(body, dict) and body.get("job_id"):
            return body
        raise ApiError("POST /grader/claim", status, body)

    def file(self, trial_id: str, rel: str) -> bytes:
        quoted = "/".join(urllib.parse.quote(seg, safe="") for seg in PurePosixPath(rel).parts)
        path = f"/trials/{urllib.parse.quote(trial_id, safe='')}/files/{quoted}"
        status, raw = self._request("GET", path)
        if status != 200:
            raise ApiError(f"GET {path}", status, self._json(raw))
        if len(raw) > MAX_DOWNLOAD_BYTES:
            raise ApiError(f"GET {path}", 413, "larger than the grader downloads")
        return raw

    def report(self, trial_id: str, body: dict[str, Any]) -> dict[str, Any]:
        path = f"/grader/trials/{urllib.parse.quote(trial_id, safe='')}/grades"
        status, raw = self._request("POST", path, body)
        parsed = self._json(raw)
        if status == 200 and isinstance(parsed, dict):
            return parsed
        raise ApiError(f"POST {path}", status, parsed)


def _sha(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _norm_sha(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    v = value.strip().lower()
    return v if v.startswith("sha256:") else "sha256:" + v


def fetch_files(api: GraderApi, job: dict[str, Any], out: Path) -> list[str]:
    """Downloads the files graders read into `out`; returns problems (hash mismatches)."""
    manifest = {
        f.get("path"): f for f in (job.get("trial") or {}).get("files") or [] if isinstance(f, dict)
    }
    problems: list[str] = []
    for rel in WANTED:
        entry = manifest.get(rel)
        if entry is None:
            continue
        try:
            data = api.file(job["trial_id"], rel)
        except NetworkError as exc:
            raise FileUnavailable(str(exc)) from exc
        except ApiError as exc:
            if exc.retryable:
                raise FileUnavailable(str(exc)) from exc
            problems.append(f"{rel} could not be downloaded: {exc}")
            continue
        expected = _norm_sha(entry.get("sha256"))
        if expected and _sha(data) != expected:
            problems.append(
                f"{rel} differs from the trial's manifest ({_sha(data)} is not {expected})"
            )
            continue
        (out / rel).write_bytes(data)
    return problems


def write_grader_files(job: dict[str, Any], task_dir: Path, repo_dir: Path | None = None) -> None:
    """A unit_test's file goes next to the task; a judge's rubric (keyed by its configs/rubrics/
    path) under `repo_dir`. Any other name, or bytes that differ from their sha256, is skipped,
    and the grade that needed it says the file is missing."""
    for name, entry in (job.get("grader_files") or {}).items():
        if not isinstance(entry, dict) or not isinstance(entry.get("base64"), str):
            continue  # listed but missing on the API's side: the grade says so
        if RUBRIC_PATH.match(name):
            if repo_dir is None:
                continue
            target = repo_dir / name
        elif "/" in name or name.startswith("."):
            continue
        else:
            target = task_dir / name
        data = base64.b64decode(entry["base64"])
        if entry.get("sha256") and _sha(data) != _norm_sha(entry["sha256"]):
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def grade_job(
    api: GraderApi,
    job: dict[str, Any],
    workdir: Path | None = None,
    judge_transport: Transport | None = None,
) -> dict[str, Any]:
    """Downloads, grades and builds the report body for one claimed job."""
    graders = job.get("graders") or []
    specs = [g.get("spec") for g in graders]
    hashes = [g.get("spec_sha256") for g in graders]
    with tempfile.TemporaryDirectory(prefix="evals-grade-", dir=workdir) as tmp:
        out = Path(tmp) / "out"
        task_dir = Path(tmp) / "task"
        repo_dir = Path(tmp) / "repo"
        out.mkdir()
        task_dir.mkdir()
        repo_dir.mkdir()
        problems = fetch_files(api, job, out)
        write_grader_files(job, task_dir, repo_dir)
        task = job.get("task") or {}
        summary = task.get("summary") if isinstance(task.get("summary"), str) else None
        report = grade_trial(
            out,
            specs,
            task_dir=task_dir,
            spec_hashes=hashes,
            end_state_fallback=(job.get("trial") or {}).get("end_state"),
            repo_root=repo_dir,
            task_summary=summary,
            # Nothing is spent on a trial whose files are not intact: its grades become errors.
            judge=None if problems else JudgeAccess.from_claim(job.get("judge")),
            judge_transport=judge_transport,
        )
    if problems:
        why = "; ".join(problems)
        for g in report["grades"]:
            g.update(
                {
                    "verdict": "error",
                    "score": None,
                    "reason": f"the trial's files are not intact: {why}",
                    "evidence": [],
                }
            )
    return {
        "worker_id": job["worker_id"],
        "job_id": job["job_id"],
        "attempt": job["attempt"],
        "framework_version": FRAMEWORK_VERSION,
        "grades": report["grades"],
        "passed": report["passed"],
        "outcome": report["outcome"],
        "problems": problems + report["trial_problems"],
    }


def report_with_retry(
    api: GraderApi, trial_id: str, body: dict[str, Any], deadline_s: float = 120.0
) -> dict[str, Any] | None:
    """The report, retried; None when the API says the claim was lost."""
    start = time.monotonic()
    delay = 1.0
    while True:
        try:
            return api.report(trial_id, body)
        except ApiError as exc:
            if exc.status == 409:
                log(f"job {body['job_id']}: {exc.code or 'conflict'}, dropping it")
                return None
            if not exc.retryable or time.monotonic() - start > deadline_s:
                raise
        except NetworkError:
            if time.monotonic() - start > deadline_s:
                raise
        time.sleep(delay + random.random())
        delay = min(delay * 2, 15.0)


def run_once(api: GraderApi, worker_id: str, workdir: Path | None = None) -> str:
    """Claims and grades one job. Returns 'idle', 'graded', 'dropped' or 'unavailable'."""
    job = api.claim(worker_id)
    if job is None:
        return "idle"
    job = {**job, "worker_id": worker_id}
    try:
        body = grade_job(api, job, workdir)
    except FileUnavailable as exc:
        log(
            f"job {job['job_id']} trial {job['trial_id']}: files unavailable ({exc});"
            " leaving it to lapse"
        )
        return "unavailable"
    accepted = report_with_retry(api, job["trial_id"], body)
    if accepted is None:
        return "dropped"
    verdicts = ", ".join(f"{g['grader_id']}={g['verdict']}" for g in body["grades"]) or "no graders"
    log(f"job {job['job_id']} trial {job['trial_id']}: {accepted.get('outcome')} ({verdicts})")
    return "graded"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="evals-grader", description="Claim trials that need grading, grade them, report."
    )
    parser.add_argument("--once", action="store_true", help="grade at most one job, then exit")
    parser.add_argument(
        "--drain", action="store_true", help="grade until nothing is left, then exit"
    )
    parser.add_argument("--poll-s", type=float, default=3.0, help="idle wait between claims")
    args = parser.parse_args(argv)
    missing = [k for k in ("EVALS_API_URL", "EVALS_WORKER_TOKEN") if not os.environ.get(k)]
    if missing:
        print(f"evals-grader: set {', '.join(missing)}", file=sys.stderr)
        return 2
    api = GraderApi(os.environ["EVALS_API_URL"], os.environ["EVALS_WORKER_TOKEN"])
    worker_id = os.environ.get("EVALS_GRADER_ID") or f"grader-{socket.gethostname()}"
    workdir = Path(os.environ["TMPDIR"]) if os.environ.get("TMPDIR") else None
    if workdir:
        workdir.mkdir(parents=True, exist_ok=True)
    log(f"{worker_id} grading with framework {FRAMEWORK_VERSION} against {api.base_url}")
    while True:
        try:
            state = run_once(api, worker_id, workdir)
        except (NetworkError, ApiError) as exc:
            log(f"API: {exc}")
            state = "error"
        if args.once:
            return 0 if state in ("idle", "graded") else 1
        if args.drain and state == "idle":
            return 0
        if state in ("idle", "error", "unavailable"):
            time.sleep(args.poll_s * (0.5 + random.random()))


if __name__ == "__main__":
    sys.exit(main())
