"""The SP3 worker: claim a trial from the API, run it, upload and report it, clean up, repeat.

docs/api-contract.md, "Worker protocol" (D2), with D3 isolation and D16 re-queues. One worker
serves one harness and runs one trial at a time in the fixed folder /trial, so every path a prompt
can carry (home, cwd, HERMES_HOME) is the same in every trial:

1. Claim: POST /worker/claim. 204 means nothing is queued for this harness: back off with jitter.
   Every claim carries the hash of the adapter code this worker runs (D85, `source_hash.py`),
   worked out once at startup; the API stores it on the trial it hands out.
2. Run: `run_trial` with an `ApiProxyClient`. The trial's keys arrive in the claim and LiteLLM's
   records of its calls come through the API, so the worker never holds the master key or a
   provider key (D2, R10.3).
3. Heartbeat: a thread posts every 10 s from the claim until the report is accepted. A 409 means
   the API gave up on the claim: the trial's process group is killed and nothing is reported,
   because the API has already queued the next attempt.
4. Upload: each regular file of /trial/out goes to PUT /worker/trials/:id/files/<path> with its
   sha256. The API stores it under runs/<experiment>/<trial>/attempt-<n>/ and never overwrites it;
   the worker never mounts runs/, so no trial can see another trial's stored files (D2, D3).
   Symlinks and special files are not followed or sent.
5. Report: POST, naming the files the API now holds, retried on network errors and 5xx. The API
   treats a repeat of an upload or a report as a no-op.
6. Between trials: kill leftover processes, wipe /trial, and check it is empty (D3). A worker that
   cannot empty its trial folder stops rather than claim again.

Config comes from the environment: EVALS_API_URL (with the API's /api prefix), EVALS_WORKER_TOKEN,
EVALS_HARNESS, EVALS_ADAPTER_CMD (split like a shell line) and EVALS_WORKER_ID (default
<harness>-<hostname>). EVALS_WORKER_ISOLATION=container, set in the worker images, widens the
sweep to every process in the container but the worker, and wipes /dev/shm with /trial.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import contextlib
import hashlib
import http.client
import json
import os
import random
import shlex
import signal
import socket
import stat
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from evals_adapter.adapter import utc_iso
from evals_adapter.proxy import SPEND_LOG_QUIET_S, ProxyClient, ProxyError, TrialKey
from evals_adapter.runner import (
    ProxySettings,
    TrialInputs,
    _proc_entries,
    kill_all,
    run_trial,
)
from evals_adapter.source_hash import SourceHashError, adapter_source_sha256
from evals_adapter.spec import DEFAULT_TRIAL_DIR, TRIAL_DIR_ENV, TrialPaths

TRIAL_ROOT = Path(DEFAULT_TRIAL_DIR)
HEARTBEAT_S = 10.0
MAX_FILE_BYTES = 64 * 1024 * 1024  # the API's limit per uploaded file (docs/api-contract.md)
ISOLATION_ENV = "EVALS_WORKER_ISOLATION"
CONTAINER_WIPES = (Path("/dev/shm"),)  # writable in every container even with a read-only root
REQUIRED_ENV = ("EVALS_API_URL", "EVALS_WORKER_TOKEN", "EVALS_HARNESS", "EVALS_ADAPTER_CMD")


def log(message: str) -> None:
    print(f"[evals-worker] {utc_iso(time.time())} {message}", file=sys.stderr, flush=True)


# ---- errors ---------------------------------------------------------------------------------


class NetworkError(RuntimeError):
    """The API could not be reached or the connection broke. Always worth retrying."""


class ApiError(RuntimeError):
    """The API answered with a status the call did not expect."""

    def __init__(self, what: str, status: int, body: Any) -> None:
        self.status = status
        self.code = body.get("error") if isinstance(body, dict) else None
        super().__init__(f"{what}: HTTP {status}: {str(body)[:300]}")

    @property
    def retryable(self) -> bool:
        return self.status >= 500 or self.status == 429


class TrialStopped(RuntimeError):  # noqa: N818 - a stop, not a fault
    """The trial must stop without a report: the claim was lost, or the worker is shutting down."""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


class ClaimLost(TrialStopped):
    def __init__(self, what: str) -> None:
        super().__init__(f"claim_lost ({what})")


class UploadRefused(RuntimeError):
    """The API holds a different file at this path for the attempt, or no longer takes new ones.
    Stored files are never overwritten, so the attempt cannot be reported faithfully."""


class WorkerFault(RuntimeError):
    """The worker cannot go on safely, for example the trial folder will not empty (D3)."""


# ---- the API --------------------------------------------------------------------------------


def _json(raw: bytes) -> Any:
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return raw[:300].decode("utf-8", "replace")


class ApiClient:
    """The worker endpoints of the control-plane API, with the worker token (D2)."""

    def __init__(self, base_url: str, token: str, timeout_s: float = 15.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout_s = timeout_s

    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        data: bytes | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> tuple[int, Any]:
        """A JSON `body`, or raw `data` with its own `headers` (Content-Type among them)."""
        sent = {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            **(headers or {}),
        }
        if data is None and body is not None:
            data = json.dumps(body).encode()
        req = urllib.request.Request(self.base_url + path, data=data, headers=sent, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:  # noqa: S310
                return resp.status, _json(resp.read())
        except urllib.error.HTTPError as exc:
            return exc.code, _json(exc.read())
        except (urllib.error.URLError, http.client.HTTPException, OSError) as exc:
            raise NetworkError(f"{method} {path}: {exc!r}") from exc

    @staticmethod
    def _trial(trial_id: str) -> str:
        return "/worker/trials/" + urllib.parse.quote(trial_id, safe="")

    def claim(
        self, worker_id: str, harness: str, adapter_sha256: str | None = None
    ) -> dict[str, Any] | None:
        """`adapter_sha256` is the adapter code's hash (D85), null when the worker has none."""
        status, body = self.request(
            "POST",
            "/worker/claim",
            {"worker_id": worker_id, "harness": harness, "adapter_sha256": adapter_sha256},
        )
        if status == 204:
            return None
        if 200 <= status < 300 and isinstance(body, dict) and body.get("trial_id"):
            return body
        raise ApiError("POST /worker/claim", status, body)

    def heartbeat(self, trial_id: str, worker_id: str, attempt: int) -> None:
        path = self._trial(trial_id) + "/heartbeat"
        status, body = self.request("POST", path, {"worker_id": worker_id, "attempt": attempt})
        if status == 409:
            raise ClaimLost(f"heartbeat for {trial_id} attempt {attempt}")
        if not 200 <= status < 300:
            raise ApiError(f"POST {path}", status, body)

    def calls(self, trial_id: str, role: str) -> list[dict[str, Any]]:
        path = self._trial(trial_id) + "/calls?role=" + urllib.parse.quote(role)
        status, body = self.request("GET", path)
        if status == 409:
            raise ClaimLost(f"calls for {trial_id}")
        if status != 200 or not isinstance(body, list):
            raise ApiError(f"GET {path}", status, body)
        return body

    def put_file(
        self, trial_id: str, worker_id: str, attempt: int, rel: str, data: bytes, sha256: str
    ) -> Any:
        """One file of the trial's out/ folder. 201 stored, 200 the same bytes already were."""
        query = urllib.parse.urlencode({"worker_id": worker_id, "attempt": attempt})
        path = f"{self._trial(trial_id)}/files/{urllib.parse.quote(rel, safe='/')}?{query}"
        status, resp = self.request(
            "PUT",
            path,
            data=data,
            headers={"Content-Type": "application/octet-stream", "X-Content-Sha256": sha256},
        )
        code = resp.get("error") if isinstance(resp, dict) else None
        if status == 409 and code == "claim_lost":
            raise ClaimLost(f"upload of {rel} for {trial_id} attempt {attempt}")
        if status == 409:
            raise UploadRefused(f"PUT {rel} for {trial_id}: {str(resp)[:300]}")
        if not 200 <= status < 300:
            raise ApiError(f"PUT {rel} for {trial_id}", status, resp)
        return resp

    def report(self, trial_id: str, body: dict[str, Any]) -> Any:
        path = self._trial(trial_id) + "/report"
        status, resp = self.request("POST", path, body)
        if status == 409:
            raise ClaimLost(f"report for {trial_id} attempt {body.get('attempt')}")
        if not 200 <= status < 300:
            raise ApiError(f"POST {path}", status, resp)
        return resp


class TrialControl:
    """Shared by the main thread and the heartbeat thread: whether the trial must stop, and the
    adapter process whose group is killed when it must."""

    def __init__(self) -> None:
        # Re-entrant: the SIGTERM handler runs on the main thread and may land while it holds it.
        self._lock = threading.RLock()
        self._proc: subprocess.Popen | None = None
        self.reason: str | None = None
        self.stopped = threading.Event()

    def spawned(self, proc: subprocess.Popen) -> None:
        with self._lock:
            self._proc = proc
            if self.reason is not None:
                self._kill()

    def stop(self, reason: str) -> None:
        with self._lock:
            if self.reason is None:
                self.reason = reason
            self.stopped.set()
            self._kill()

    def _kill(self) -> None:
        proc = self._proc
        if proc is not None and proc.poll() is None:
            # start_new_session made the adapter its group's leader; leftovers outside the group
            # are caught by the runner's sweep when the adapter exits.
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(proc.pid, signal.SIGKILL)

    def check(self) -> None:
        if self.stopped.is_set():
            raise TrialStopped(self.reason or "stopped")


class GaveUp(RuntimeError):  # noqa: N818 - a deadline, not a fault of its own
    """A call kept failing with network errors, 5xx or 429 until its deadline passed."""


def retry_until(
    what: str,
    call: Callable[[], Any],
    control: TrialControl,
    deadline: float,
    delay_for: Callable[[int], float],
) -> Any:
    """Repeat `call` on network errors, 5xx and 429, waiting `delay_for(n)` after the n-th
    failure, until it answers or `deadline` (time.monotonic) passes, then raise GaveUp. Any other
    refusal is raised at once; a stopped trial stops the waiting (TrialStopped)."""
    n = 0
    while True:
        control.check()
        try:
            return call()
        except ApiError as exc:
            if not exc.retryable:
                raise
            error: Exception = exc
        except NetworkError as exc:
            error = exc
        if time.monotonic() >= deadline:
            raise GaveUp(f"gave up on the {what}: {error}") from error
        delay = delay_for(n)
        log(f"{what} failed ({error}); sending it again in {delay:.1f} s")
        n += 1
        if control.stopped.wait(delay):
            control.check()


def default_backoff(n: int) -> float:
    """1 s, doubling to at most 30 s, with jitter: WorkerConfig's retry_base_s and retry_max_s."""
    return min(30.0, 1.0 * 2 ** min(n, 16)) * (0.5 + 0.5 * random.random())  # noqa: S311


class ApiProxyClient(ProxyClient):
    """The runner's `ProxyClient` over the API's worker endpoints (D2).

    - `create_key` returns the keys the claim carried: the API minted them, each limited to the
      trial's model and budget. The key's `token` is the role, which is all the API needs.
    - `read_calls` polls GET /worker/trials/:id/calls with ProxyClient's wait and settle logic.
      Each read is retried on network errors, 5xx and 429 for up to `deadline_s` (E2, 6 Nov
      review: three tries 1 s apart threw a finished trial away when the API, LiteLLM or Postgres
      was down for more than 2 s; the worker gives these reads the same back-off and deadline as
      its uploads and its report, WorkerConfig.report_retry_s).
    - `revoke` does nothing: the API revokes when the trial is reported or its claim lapses.
    """

    ROLE_KEYS = {"agent": "model", "sim": "sim"}

    def __init__(
        self,
        api: ApiClient,
        trial_id: str,
        keys: Mapping[str, Any],
        control: TrialControl | None = None,
        deadline_s: float = 600.0,
        backoff: Callable[[int], float] = default_backoff,
    ) -> None:
        # No ProxyClient.__init__: the worker has no LiteLLM URL and no master key.
        self.api = api
        self.trial_id = trial_id
        self.keys = dict(keys)
        self.control = control
        self.deadline_s = deadline_s
        self.backoff = backoff

    def create_key(
        self, trial_id: str, role: str, max_budget_usd: float, models: list[str]
    ) -> TrialKey:
        if trial_id != self.trial_id:
            raise ProxyError(f"asked for a key for {trial_id}, but the claim is {self.trial_id}")
        name = self.ROLE_KEYS.get(role)
        key = self.keys.get(name) if name else None
        if not isinstance(key, str) or not key:
            raise ProxyError(f"the claim for {trial_id} carried no keys.{name or role}")
        return TrialKey(key=key, token=role)

    def revoke(self, keys: list[TrialKey]) -> None:
        return None

    def _spend_rows(self, token: str) -> list[dict]:
        try:
            return retry_until(
                f"read of the {token} calls for {self.trial_id}",
                lambda: self.api.calls(self.trial_id, token),
                self.control or TrialControl(),
                time.monotonic() + self.deadline_s,
                self.backoff,
            )
        except ApiError as exc:  # a refusal that repeating will not change
            raise ProxyError(str(exc)) from exc
        except GaveUp as exc:
            raise ProxyError(
                f"could not read the {token} calls for {self.trial_id}: {exc}"
            ) from exc


class Heartbeat:
    """Posts a heartbeat every `interval_s` until stopped. Network errors and 5xx are logged and
    retried at the next beat, since the API alone decides when a lease lapses; a 409 stops the
    trial."""

    def __init__(
        self,
        api: ApiClient,
        trial_id: str,
        worker_id: str,
        attempt: int,
        interval_s: float,
        control: TrialControl,
    ) -> None:
        self.api, self.trial_id, self.worker_id, self.attempt = api, trial_id, worker_id, attempt
        self.interval_s = interval_s
        self.control = control
        self.sent = 0
        self.failed = 0
        self._done = threading.Event()
        self._thread = threading.Thread(target=self._run, name=f"heartbeat-{trial_id}", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def _run(self) -> None:
        while not self._done.wait(self.interval_s):
            try:
                self.api.heartbeat(self.trial_id, self.worker_id, self.attempt)
                self.sent += 1
            except ClaimLost:
                log(f"{self.trial_id} attempt {self.attempt}: the API says the claim is lost")
                self.control.stop("claim_lost")
                return
            except (NetworkError, ApiError) as exc:
                self.failed += 1
                log(f"heartbeat for {self.trial_id} failed, trying again next beat: {exc}")

    def stop(self) -> None:
        self._done.set()
        if self._thread.is_alive():
            self._thread.join(timeout=self.api.timeout_s + 5)


# ---- files ----------------------------------------------------------------------------------


def sha256_file(path: Path) -> tuple[int, str]:
    h = hashlib.sha256()
    size = 0
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            size += len(chunk)
            h.update(chunk)
    return size, h.hexdigest()


def regular_files(folder: Path) -> tuple[list[tuple[str, Path]], list[str]]:
    """The regular files under `folder` as (relative path, path), sorted, and what was skipped.
    Symlinks (to files or folders) and special files are not followed, so a trial cannot make the
    worker send files from outside its folder, such as the worker's own /proc entries."""
    found, skipped = [], []
    for dirpath, dirnames, filenames in os.walk(folder, followlinks=False):
        rel = Path(dirpath).relative_to(folder)
        for name in list(dirnames):
            if (Path(dirpath) / name).is_symlink():
                skipped.append((rel / name).as_posix())
                dirnames.remove(name)
        dirnames.sort()
        for name in filenames:
            path = Path(dirpath) / name
            if stat.S_ISREG(os.lstat(path).st_mode):
                found.append(((rel / name).as_posix(), path))
            else:
                skipped.append((rel / name).as_posix())
    found.sort()
    return found, sorted(skipped)


def read_regular(path: Path) -> bytes:
    """The file's bytes, refusing a symlink put in its place since it was listed."""
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd, "rb") as fh:
        return fh.read()


def files_manifest(folder: Path) -> list[dict[str, Any]]:
    """Every regular file under `folder`: relative path, size and sha256 (contract v2's form)."""
    rows = []
    for rel, path in regular_files(folder)[0]:
        size, digest = sha256_file(path)
        rows.append({"path": rel, "bytes": size, "sha256": digest})
    return rows


def _own_rwx(path: str | Path, st: os.stat_result) -> None:
    """A trial can take permissions off its own folders. The worker owns them (same user), so it
    gives itself rwx back before emptying them. Folders it does not own, such as /dev/shm, are
    left as they are."""
    mode = stat.S_IMODE(st.st_mode)
    if st.st_uid == os.getuid() and mode & stat.S_IRWXU != stat.S_IRWXU:
        os.chmod(path, mode | stat.S_IRWXU)


def _remove(path: str) -> None:
    st = os.lstat(path)
    if stat.S_ISDIR(st.st_mode):
        _own_rwx(path, st)
        with os.scandir(path) as entries:
            for entry in entries:
                _remove(entry.path)
        os.rmdir(path)
    else:
        os.unlink(path)


def wipe(root: Path) -> None:
    """Remove everything inside `root`. The folder itself stays: /trial is a mount point."""
    if not root.exists():
        root.mkdir(parents=True)
        return
    _own_rwx(root, os.stat(root))
    with os.scandir(root) as entries:
        for entry in entries:
            _remove(entry.path)


def _environ_has(pid: int, entry: bytes) -> bool:
    try:
        return entry in Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
    except OSError:
        return False


def _ancestors(pid: int) -> set[int]:
    seen: set[int] = set()
    while pid > 1 and pid not in seen:
        seen.add(pid)
        try:
            pid = int(Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            break
    seen.add(pid)
    return seen


def sweep_host(trial_root: Path) -> int:
    """Kill every process started for a trial in `trial_root`: the runner gives each one
    EVALS_TRIAL_DIR, and its children inherit it. For a worker on a shared host (tests, dev)."""
    me = os.getpid()
    entry = f"{TRIAL_DIR_ENV}={trial_root}".encode()
    victims = {pid for pid, _, _ in _proc_entries() if pid != me and _environ_has(pid, entry)}
    return kill_all(victims)


def sweep_container() -> int:
    """Kill every process in the container except the worker and its ancestors (an init, if
    any). Inside a worker container nothing else should be alive between trials, so this also
    catches a process that left the trial's session and cleared its environment."""
    keep = _ancestors(os.getpid())
    return kill_all({pid for pid, _, _ in _proc_entries() if pid not in keep})


def reap_children() -> int:
    """Collect exited children. As PID 1 the worker inherits every orphan of a trial."""
    reaped = 0
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return reaped
        if pid == 0:
            return reaped
        reaped += 1


def _safe_part(value: Any) -> bool:
    return (
        isinstance(value, str)
        and value not in ("", ".", "..")
        and "/" not in value
        and "\\" not in value
        and "\0" not in value
    )


def _safe_relative(name: Any) -> bool:
    if not isinstance(name, str) or not name or "\0" in name:
        return False
    p = PurePosixPath(name)
    return not p.is_absolute() and ".." not in p.parts


def claim_problem(claim: Mapping[str, Any]) -> str | None:
    """Why the worker cannot run this claim as the contract describes it, or None."""
    trial_id, attempt, spec = claim.get("trial_id"), claim.get("attempt"), claim.get("spec")
    if not _safe_part(trial_id):
        return f"trial_id {trial_id!r} is not a usable id"
    if not isinstance(attempt, int) or isinstance(attempt, bool) or attempt < 1:
        return f"attempt {attempt!r} is not a positive integer"
    if not isinstance(spec, dict) or not isinstance(spec.get("trial"), dict):
        return "spec is missing or has no trial block"
    trial = spec["trial"]
    if trial.get("id") != trial_id:
        return f"spec.trial.id {trial.get('id')!r} is not the claimed {trial_id!r}"
    if trial.get("attempt") != attempt:
        return f"spec.trial.attempt {trial.get('attempt')!r} is not the claimed {attempt}"
    experiment = trial.get("experiment_id")
    if experiment is not None and not _safe_part(experiment):
        return f"spec.trial.experiment_id {experiment!r} is not a usable id"
    files = claim.get("state_files") or {}
    if not isinstance(files, dict):
        return "state_files is not an object"
    for name, data in files.items():
        if not _safe_relative(name):
            return f"state file name {name!r} is not a plain relative path"
        if not isinstance(data, str):
            return f"state file {name!r} is not base64 text"
        try:
            base64.b64decode(data, validate=True)
        except (binascii.Error, ValueError):
            return f"state file {name!r} is not valid base64"
    keys = claim.get("keys")
    if not isinstance(keys, dict) or not keys.get("model"):
        return "keys.model is missing"
    return None


def read_spans(path: Path) -> list[dict[str, Any]]:
    """The trace's spans as stored. Lines that are not JSON are left out here; the runner
    report's trace_errors already names them, and the stored file keeps them."""
    spans = []
    if path.exists():
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            with contextlib.suppress(ValueError):
                span = json.loads(line)
                if isinstance(span, dict):
                    spans.append(span)
    return spans


# ---- the worker -----------------------------------------------------------------------------


@dataclass
class WorkerConfig:
    api_url: str
    token: str
    harness: str
    adapter_cmd: list[str]
    worker_id: str
    trial_root: Path = TRIAL_ROOT
    isolation: str = "host"  # "container" in the worker images
    heartbeat_s: float = HEARTBEAT_S
    idle_base_s: float = 1.0
    idle_max_s: float = 15.0
    retry_base_s: float = 1.0
    retry_max_s: float = 30.0
    # For each read of the trial's calls (E2), the uploads and the report; then the lease lapses.
    report_retry_s: float = 600.0
    max_file_bytes: int = MAX_FILE_BYTES
    # How long after the adapter exits before LiteLLM's log can count as complete (proxy.py);
    # tests on a fake API shorten it.
    spend_log_quiet_s: float = SPEND_LOG_QUIET_S

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None, **overrides: Any) -> WorkerConfig:
        env = os.environ if env is None else env
        missing = [name for name in REQUIRED_ENV if not env.get(name)]
        if missing:
            raise SystemExit(f"evals-worker: set {', '.join(missing)}")
        harness = env["EVALS_HARNESS"]
        isolation = env.get(ISOLATION_ENV, "host")
        if isolation not in ("host", "container"):
            raise SystemExit(f"evals-worker: {ISOLATION_ENV} must be host or container")
        values: dict[str, Any] = {
            "api_url": env["EVALS_API_URL"],
            "token": env["EVALS_WORKER_TOKEN"],
            "harness": harness,
            "adapter_cmd": shlex.split(env["EVALS_ADAPTER_CMD"]),
            "worker_id": env.get("EVALS_WORKER_ID") or f"{harness}-{socket.gethostname()}",
            "isolation": isolation,
        }
        values.update({k: v for k, v in overrides.items() if v is not None})
        return cls(**values)


class Worker:
    def __init__(
        self,
        config: WorkerConfig,
        api: ApiClient | None = None,
        sleep: Callable[[float], Any] | None = None,
        rand: Callable[[], float] | None = None,
    ) -> None:
        self.cfg = config
        self.api = api or ApiClient(config.api_url, config.token)
        self.paths = TrialPaths(config.trial_root)
        self._stop = threading.Event()
        self._sleep = sleep or self._stop.wait  # a shutdown cuts a back-off short
        self._rand = rand or random.random
        self._control: TrialControl | None = None
        # D85: the hash of the adapter code this worker runs, worked out when it starts serving.
        self.adapter_sha256: str | None = None
        self.handled = 0
        self.outcomes: list[tuple[str, Any, str]] = []  # (trial_id, attempt, outcome)

    # -- lifecycle

    def shutdown(self, reason: str = "shutdown") -> None:
        """Stop claiming. A running trial is killed and not reported, as after a crash: the
        API re-queues it when the lease lapses."""
        self._stop.set()
        control = self._control
        if control is not None:
            control.stop(reason)

    def _jitter(self, base: float, cap: float, n: int) -> float:
        ceiling = min(cap, base * 2 ** min(n, 16))
        return ceiling * (0.5 + 0.5 * self._rand())

    def idle_backoff_s(self, n: int) -> float:
        return self._jitter(self.cfg.idle_base_s, self.cfg.idle_max_s, n)

    def serve(self, max_trials: int | None = None, exit_on_idle: bool = False) -> int:
        """Claim and run trials until shut down (or `max_trials`, or the first 204 with
        `exit_on_idle`). Returns the process exit code."""
        log(
            f"worker {self.cfg.worker_id} for {self.cfg.harness}: API {self.cfg.api_url}, "
            f"trial folder {self.paths.root}, isolation {self.cfg.isolation}"
        )
        self.clean()  # a crashed predecessor may have left processes or files
        self.adapter_sha256 = self.adapter_code()
        idle = 0
        while not self._stop.is_set():
            if max_trials is not None and self.handled >= max_trials:
                break
            try:
                claim = self.api.claim(self.cfg.worker_id, self.cfg.harness, self.adapter_sha256)
            except (NetworkError, ApiError) as exc:
                log(f"claim failed: {exc}")
                self._sleep(self.idle_backoff_s(idle))
                idle += 1
                continue
            if claim is None:
                if exit_on_idle:
                    break
                self._sleep(self.idle_backoff_s(idle))
                idle += 1
                continue
            idle = 0
            self.handle(claim)
            self.handled += 1
        log(f"worker {self.cfg.worker_id} stopping after {self.handled} trial(s)")
        return 0

    def adapter_code(self) -> str | None:
        """D85: the sha256 of the adapter code this worker runs, or None, said in the log.

        The packages are found by the adapter's own interpreter, started as the runner starts the
        adapter (the same command up to `-m`, a clean environment, an empty working folder), so
        the hash covers the files a trial imports (`source_hash.py`). A command that runs no
        module, such as a test fixture script, gets no hash: its trials say it was not recorded.
        """
        env = {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "LANG": "C.UTF-8",
            "HOME": str(self.paths.home),
            "TMPDIR": str(self.paths.tmp),
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        cwd = self.paths.root if self.paths.root.is_dir() else None  # serve() has just wiped it
        try:
            digest, packages = adapter_source_sha256(self.cfg.adapter_cmd, env=env, cwd=cwd)
        except SourceHashError as exc:
            log(f"adapter code hash: none, so this worker's trials record none ({exc})")
            return None
        log(f"adapter code hash {digest}, over {', '.join(str(p) for p in packages)}")
        return digest

    def heartbeat_s(self, claim: Mapping[str, Any]) -> float:
        lease = claim.get("lease_s")
        if isinstance(lease, int | float) and not isinstance(lease, bool) and lease > 0:
            return min(self.cfg.heartbeat_s, lease / 3)
        return self.cfg.heartbeat_s

    # -- one trial

    def handle(self, claim: dict[str, Any]) -> str:
        """Run one claimed trial to a report, or stop it without one. Returns the outcome:
        reported, stopped, refused or failed. Always cleans the trial folder afterwards."""
        trial_id, attempt = claim.get("trial_id"), claim.get("attempt")
        problem = claim_problem(claim)
        if problem is not None:
            # Running it anyway could store or label it wrongly. Without heartbeats the lease
            # lapses and the API counts the attempt as abandoned.
            log(f"refusing claim {trial_id} attempt {attempt}: {problem}")
            self.outcomes.append((str(trial_id), attempt, "refused"))
            return "refused"
        log(f"claimed {trial_id} attempt {attempt}")
        control = TrialControl()
        self._control = control
        if self._stop.is_set():
            control.stop("shutdown")
        beat = Heartbeat(
            self.api, trial_id, self.cfg.worker_id, attempt, self.heartbeat_s(claim), control
        )
        beat.start()
        outcome = "failed"
        try:
            self._run_upload_report(claim, control)
            outcome = "reported"
        except TrialStopped as exc:
            outcome = "stopped"
            log(f"{trial_id} attempt {attempt} stopped ({exc.reason}); nothing reported")
        except Exception as exc:  # noqa: BLE001 - one trial's failure must not stop the worker
            log(
                f"{trial_id} attempt {attempt} failed in the worker, nothing reported, the lease "
                f"will lapse: {exc!r}\n{traceback.format_exc()}"
            )
        finally:
            beat.stop()
            self._control = None
            self.outcomes.append((trial_id, attempt, outcome))
            self.clean()
        return outcome

    def _run_upload_report(self, claim: dict[str, Any], control: TrialControl) -> None:
        trial_id, attempt, spec = claim["trial_id"], claim["attempt"], claim["spec"]
        state = {
            name: base64.b64decode(data, validate=True)
            for name, data in (claim.get("state_files") or {}).items()
        }
        inputs = TrialInputs(
            spec=spec,
            adapter_cmd=list(self.cfg.adapter_cmd),
            state_files=state,
            # D22: the simulator replies the API holds for this task, simulator and prompt. Its
            # new replies go back in out/sim_replies.jsonl, which the API adds to the cache.
            sim_cache=claim.get("sim_cache"),
        )
        budgets = claim.get("budgets") or {}
        proxy = ProxySettings(
            ApiProxyClient(
                self.api,
                trial_id,
                claim["keys"],
                control,
                deadline_s=self.cfg.report_retry_s,
                backoff=lambda n: self._jitter(self.cfg.retry_base_s, self.cfg.retry_max_s, n),
            ),
            budget_usd=float(budgets.get("trial_usd") or 0.0),
            sim_budget_usd=float(budgets.get("sim_usd") or 0.0),
            spend_log_quiet_s=self.cfg.spend_log_quiet_s,
        )
        control.check()
        runner_report = run_trial(self.paths.root, inputs, proxy, on_spawn=control.spawned)
        control.check()
        # The trial's processes are dead (the runner swept them), so out/ no longer changes.
        result = None
        if runner_report["adapter"]["result_valid"]:
            result = json.loads(self.paths.result.read_text(encoding="utf-8"))
        spans = read_spans(self.paths.trace)
        deadline = time.monotonic() + self.cfg.report_retry_s
        files = self.upload(trial_id, attempt, self.paths.out, control, deadline)
        body = {
            "worker_id": self.cfg.worker_id,
            "attempt": attempt,
            "runner_report": runner_report,
            "result": result,
            "spans": spans,
            "files": files,
        }
        self.send_report(trial_id, body, control, deadline)
        log(
            f"reported {trial_id} attempt {attempt}: {runner_report['label']}, "
            f"end_state {runner_report['end_state']}, {len(files)} file(s) uploaded"
        )

    def upload(
        self, trial_id: str, attempt: int, out: Path, control: TrialControl, deadline: float
    ) -> list[dict[str, Any]]:
        """PUT every regular file of `out` to the API and return their manifest. A file over the
        API's limit is not sent but stays in the manifest, so the API flags it as not uploaded
        instead of the report hiding it."""
        found, skipped = regular_files(out)
        if skipped:
            log(f"not uploaded (symlinks or special files): {skipped[:20]}")
        rows = []
        for rel, path in found:
            control.check()
            if os.lstat(path).st_size > self.cfg.max_file_bytes:
                size, digest = sha256_file(path)
                log(f"not uploaded: {rel} is {size} bytes, over {self.cfg.max_file_bytes}")
                rows.append({"path": rel, "bytes": size, "sha256": digest})
                continue
            data = read_regular(path)
            digest = hashlib.sha256(data).hexdigest()
            rows.append({"path": rel, "bytes": len(data), "sha256": digest})
            sha = f"sha256:{digest}"

            def put(rel: str = rel, data: bytes = data, sha: str = sha) -> Any:
                return self.api.put_file(trial_id, self.cfg.worker_id, attempt, rel, data, sha)

            try:
                self._until_accepted(f"upload of {rel} for {trial_id}", put, control, deadline)
            except ApiError as exc:
                if exc.status != 413:
                    raise
                log(f"not uploaded: the API refused {rel} as too large ({exc})")
        return rows

    def send_report(
        self,
        trial_id: str,
        body: dict[str, Any],
        control: TrialControl,
        deadline: float | None = None,
    ) -> None:
        """POST the report until the API accepts it. The same body every time: the API treats a
        repeat of an attempt as a no-op, so a report whose answer was lost is simply sent again."""
        if deadline is None:
            deadline = time.monotonic() + self.cfg.report_retry_s
        self._until_accepted(
            f"report for {trial_id}", lambda: self.api.report(trial_id, body), control, deadline
        )

    def _until_accepted(
        self, what: str, call: Callable[[], Any], control: TrialControl, deadline: float
    ) -> Any:
        """Repeat `call` on network errors, 5xx and 429, with jittered back-off, until it answers
        or `deadline` passes. Any other refusal is raised at once."""
        return retry_until(
            what,
            call,
            control,
            deadline,
            lambda n: self._jitter(self.cfg.retry_base_s, self.cfg.retry_max_s, n),
        )

    # -- between trials (D3)

    def clean(self) -> None:
        """Kill leftover processes, wipe the trial folder, and check that it is empty."""
        if self.cfg.isolation == "container":
            killed = sweep_container()
            reap_children()
            extra = [p for p in CONTAINER_WIPES if p.is_dir()]
        else:
            killed = sweep_host(self.paths.root)
            extra = []
        if killed:
            log(f"killed {killed} leftover process(es)")
        for root in [self.paths.root, *extra]:
            try:
                wipe(root)
            except OSError as exc:
                raise WorkerFault(f"could not wipe {root}: {exc!r}") from exc
            left = sorted(p.name for p in root.iterdir())
            if left:
                raise WorkerFault(f"{root} is not empty after the wipe: {left[:20]}")


def _non_dumpable() -> None:
    """Make the worker's /proc entries unreadable to the trial's processes, which run as the same
    user: they hold the worker token in the worker's environment (D2). Linux only; children are
    dumpable again after exec, so the runner's sweep can still read their environment."""
    if not sys.platform.startswith("linux"):
        return
    try:
        import ctypes  # noqa: PLC0415

        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(4, 0, 0, 0, 0) != 0:  # PR_SET_DUMPABLE, 0
            log(f"prctl(PR_SET_DUMPABLE, 0) failed: errno {ctypes.get_errno()}")
    except (OSError, AttributeError) as exc:
        log(f"could not make the worker non-dumpable: {exc!r}")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="The SP3 worker loop: claim, run, heartbeat, upload, report, clean (D2, D3)."
    )
    parser.add_argument("--max-trials", type=int, help="stop after this many claims")
    parser.add_argument("--exit-on-idle", action="store_true", help="stop at the first 204")
    # Fixed in production (/trial, 10 s). Overridable for tests on a shared host.
    parser.add_argument("--trial-root", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--heartbeat-s", type=float, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    cfg = WorkerConfig.from_env(trial_root=args.trial_root, heartbeat_s=args.heartbeat_s)
    _non_dumpable()
    worker = Worker(cfg)

    def on_signal(signum: int, _frame: Any) -> None:
        log(f"signal {signum}: stopping")
        worker.shutdown("shutdown")

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    try:
        code = worker.serve(max_trials=args.max_trials, exit_on_idle=args.exit_on_idle)
    except WorkerFault as exc:
        log(f"stopping: {exc}")
        sys.exit(2)
    sys.exit(code)


if __name__ == "__main__":
    main()
