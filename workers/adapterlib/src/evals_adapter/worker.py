"""The SP3 worker: claim a trial from the API, run it, store and report it, clean up, repeat.

docs/api-contract.md, "Worker protocol" (D2), with D3 isolation and D16 re-queues. One worker
serves one harness and runs one trial at a time in the fixed folder /trial, so every path a prompt
can carry (home, cwd, HERMES_HOME) is the same in every trial:

1. Claim: POST /worker/claim. 204 means nothing is queued for this harness: back off with jitter.
2. Run: `run_trial` with an `ApiProxyClient`. The trial's keys arrive in the claim and LiteLLM's
   records of its calls come through the API, so the worker never holds the master key or a
   provider key (D2, R10.3).
3. Heartbeat: a thread posts every 10 s from the claim until the report is accepted. A 409 means
   the API gave up on the claim: the trial's process group is killed and nothing is reported,
   because the API has already queued the next attempt.
4. Store: /trial/out is copied to /runs/<experiment>/<trial>/attempt-<n>/ through a partial folder
   that is renamed into place, so a crash never leaves a half-written attempt folder and an
   existing attempt folder is never overwritten.
5. Report: POST, retried on network errors and 5xx. The API treats a repeat as a no-op.
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
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from evals_adapter.adapter import utc_iso
from evals_adapter.proxy import ProxyClient, ProxyError, TrialKey
from evals_adapter.runner import (
    ProxySettings,
    TrialInputs,
    _proc_entries,
    kill_all,
    run_trial,
)
from evals_adapter.spec import DEFAULT_TRIAL_DIR, TRIAL_DIR_ENV, TrialPaths

TRIAL_ROOT = Path(DEFAULT_TRIAL_DIR)
RUNS_DIR = Path("/runs")
NO_EXPERIMENT = "no-experiment"  # folder for a trial whose spec has experiment_id null
HEARTBEAT_S = 10.0
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


class StoreConflict(RuntimeError):
    """The attempt folder already exists with different files. It is never overwritten."""


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

    def request(self, method: str, path: str, body: Any = None) -> tuple[int, Any]:
        req = urllib.request.Request(
            self.base_url + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method=method,
        )
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

    def claim(self, worker_id: str, harness: str) -> dict[str, Any] | None:
        status, body = self.request(
            "POST", "/worker/claim", {"worker_id": worker_id, "harness": harness}
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


class ApiProxyClient(ProxyClient):
    """The runner's `ProxyClient` over the API's worker endpoints (D2).

    - `create_key` returns the keys the claim carried: the API minted them, each limited to the
      trial's model and budget. The key's `token` is the role, which is all the API needs.
    - `call_records` polls GET /worker/trials/:id/calls with ProxyClient's wait and settle logic.
    - `revoke` does nothing: the API revokes when the trial is reported or its claim lapses.
    """

    ROLE_KEYS = {"agent": "model", "sim": "sim"}

    def __init__(
        self,
        api: ApiClient,
        trial_id: str,
        keys: Mapping[str, Any],
        control: TrialControl | None = None,
        retries: int = 3,
        retry_s: float = 1.0,
    ) -> None:
        # No ProxyClient.__init__: the worker has no LiteLLM URL and no master key.
        self.api = api
        self.trial_id = trial_id
        self.keys = dict(keys)
        self.control = control
        self.retries = retries
        self.retry_s = retry_s

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
        last: Exception | None = None
        for n in range(self.retries):
            if self.control is not None:
                self.control.check()
            try:
                return self.api.calls(self.trial_id, token)
            except NetworkError as exc:
                last = exc
            except ApiError as exc:
                if not exc.retryable:
                    raise ProxyError(str(exc)) from exc
                last = exc
            if n + 1 < self.retries:
                time.sleep(self.retry_s)
        raise ProxyError(f"could not read the {token} calls for {self.trial_id}: {last}")


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


def files_manifest(folder: Path) -> list[dict[str, Any]]:
    """Every regular file under `folder`: relative path, size and sha256 (contract v2's form)."""
    rows = []
    for dirpath, dirnames, filenames in os.walk(folder, followlinks=False):
        dirnames.sort()
        for name in sorted(filenames):
            path = Path(dirpath) / name
            if not path.is_file() or path.is_symlink():
                continue
            size, digest = sha256_file(path)
            rows.append(
                {"path": path.relative_to(folder).as_posix(), "bytes": size, "sha256": digest}
            )
    rows.sort(key=lambda r: r["path"])
    return rows


def copy_regular_files(src: Path, dst: Path) -> list[str]:
    """Copy the regular files and folders under `src` into a new folder `dst`. Symlinks and
    special files are not followed or copied, so a trial cannot make the worker store files from
    outside its folder. Returns what was skipped."""
    skipped = []
    dst.mkdir(parents=True)
    for dirpath, dirnames, filenames in os.walk(src, followlinks=False):
        rel = Path(dirpath).relative_to(src)
        for name in list(dirnames):
            if (Path(dirpath) / name).is_symlink():
                skipped.append((rel / name).as_posix())
                dirnames.remove(name)
            else:
                (dst / rel / name).mkdir()
        for name in filenames:
            path = Path(dirpath) / name
            mode = os.lstat(path).st_mode
            if stat.S_ISREG(mode):
                with open(path, "rb") as fin, open(dst / rel / name, "wb") as fout:
                    while chunk := fin.read(1 << 20):
                        fout.write(chunk)
            else:
                skipped.append((rel / name).as_posix())
    return skipped


def _remove(path: str) -> None:
    st = os.lstat(path)
    if stat.S_ISDIR(st.st_mode):
        # A trial can take write permission off its own folders; the worker owns them, so it
        # gives itself the permission back before emptying them.
        os.chmod(path, stat.S_IMODE(st.st_mode) | stat.S_IRWXU)
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
    os.chmod(root, stat.S_IMODE(os.stat(root).st_mode) | stat.S_IRWXU)
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
    runs_dir: Path = RUNS_DIR
    isolation: str = "host"  # "container" in the worker images
    heartbeat_s: float = HEARTBEAT_S
    idle_base_s: float = 1.0
    idle_max_s: float = 15.0
    retry_base_s: float = 1.0
    retry_max_s: float = 30.0
    report_retry_s: float = 600.0  # then give up; the lease lapses and the API re-queues

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
            f"trial folder {self.paths.root}, runs {self.cfg.runs_dir}, "
            f"isolation {self.cfg.isolation}"
        )
        self.clean()  # a crashed predecessor may have left processes or files
        idle = 0
        while not self._stop.is_set():
            if max_trials is not None and self.handled >= max_trials:
                break
            problem = self.runs_problem()
            if problem:
                # Claiming a trial that cannot be stored would only waste an attempt.
                log(f"not claiming: {problem}")
                self._sleep(self.idle_backoff_s(idle))
                idle += 1
                continue
            try:
                claim = self.api.claim(self.cfg.worker_id, self.cfg.harness)
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

    def runs_problem(self) -> str | None:
        """Why trial folders cannot be stored, or None. Checked before every claim."""
        probe = self.cfg.runs_dir / f".write-check-{os.getpid()}"
        try:
            self.cfg.runs_dir.mkdir(parents=True, exist_ok=True)
            probe.write_bytes(b"")
            probe.unlink()
        except OSError as exc:
            return f"{self.cfg.runs_dir} is not writable by uid {os.getuid()}: {exc}"
        return None

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
            self._run_store_report(claim, control)
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

    def _run_store_report(self, claim: dict[str, Any], control: TrialControl) -> None:
        trial_id, attempt, spec = claim["trial_id"], claim["attempt"], claim["spec"]
        state = {
            name: base64.b64decode(data, validate=True)
            for name, data in (claim.get("state_files") or {}).items()
        }
        inputs = TrialInputs(
            spec=spec,
            adapter_cmd=list(self.cfg.adapter_cmd),
            state_files=state,
            # Not in the claim today (docs/api-contract.md): the D22 reply cache, if sent.
            sim_cache=claim.get("sim_cache"),
        )
        budgets = claim.get("budgets") or {}
        proxy = ProxySettings(
            ApiProxyClient(self.api, trial_id, claim["keys"], control),
            budget_usd=float(budgets.get("trial_usd") or 0.0),
            sim_budget_usd=float(budgets.get("sim_usd") or 0.0),
        )
        control.check()
        runner_report = run_trial(self.paths.root, inputs, proxy, on_spawn=control.spawned)
        control.check()
        folder = self.store(spec, attempt)
        control.check()
        result = None
        if runner_report["adapter"]["result_valid"]:
            result = json.loads((folder / "result.json").read_text(encoding="utf-8"))
        body = {
            "worker_id": self.cfg.worker_id,
            "attempt": attempt,
            "runner_report": runner_report,
            "result": result,
            "spans": read_spans(folder / "trace.jsonl"),
            "files": files_manifest(folder),
        }
        self.send_report(trial_id, body, control)
        log(
            f"reported {trial_id} attempt {attempt}: {runner_report['label']}, "
            f"end_state {runner_report['end_state']}, stored in {folder}"
        )

    def attempt_folder(self, spec: Mapping[str, Any], attempt: int) -> Path:
        trial = spec["trial"]
        experiment = trial.get("experiment_id") or NO_EXPERIMENT
        return self.cfg.runs_dir / experiment / trial["id"] / f"attempt-{attempt}"

    def store(self, spec: Mapping[str, Any], attempt: int) -> Path:
        """Copy /trial/out to the attempt's folder on the runs volume. It appears whole or not at
        all, and an existing folder is never overwritten."""
        dest = self.attempt_folder(spec, attempt)
        src = self.paths.out
        if dest.exists():
            if files_manifest(dest) == files_manifest(src):
                return dest  # stored before with the same files
            raise StoreConflict(f"{dest} already holds different files; it is not overwritten")
        dest.parent.mkdir(parents=True, exist_ok=True)
        partial = dest.parent / f".attempt-{attempt}.partial-{uuid.uuid4().hex[:8]}"
        skipped = copy_regular_files(src, partial)
        if skipped:
            log(f"not stored (symlinks or special files): {skipped[:20]}")
        try:
            os.rename(partial, dest)  # atomic; refuses to replace a folder that holds files
        except OSError as exc:
            raise StoreConflict(f"could not move the stored files into {dest}: {exc}") from exc
        return dest

    def send_report(self, trial_id: str, body: dict[str, Any], control: TrialControl) -> None:
        """POST the report until the API accepts it. The same body every time: the API treats a
        repeat of an attempt as a no-op, so a report whose answer was lost is simply sent again."""
        deadline = time.monotonic() + self.cfg.report_retry_s
        n = 0
        while True:
            control.check()
            try:
                self.api.report(trial_id, body)
                return
            except ApiError as exc:
                if not exc.retryable:
                    raise
                error: Exception = exc
            except NetworkError as exc:
                error = exc
            if time.monotonic() >= deadline:
                raise RuntimeError(f"gave up reporting {trial_id}: {error}") from error
            delay = self._jitter(self.cfg.retry_base_s, self.cfg.retry_max_s, n)
            log(f"report for {trial_id} failed ({error}); sending it again in {delay:.1f} s")
            n += 1
            if control.stopped.wait(delay):
                control.check()

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
        description="The SP3 worker loop: claim, run, heartbeat, store, report, clean (D2, D3)."
    )
    parser.add_argument("--max-trials", type=int, help="stop after this many claims")
    parser.add_argument("--exit-on-idle", action="store_true", help="stop at the first 204")
    # Fixed in production (/trial, /runs, 10 s). Overridable for tests on a shared host.
    parser.add_argument("--trial-root", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--runs-dir", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--heartbeat-s", type=float, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    cfg = WorkerConfig.from_env(
        trial_root=args.trial_root, runs_dir=args.runs_dir, heartbeat_s=args.heartbeat_s
    )
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
