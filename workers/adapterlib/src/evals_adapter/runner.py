"""The runner side of contract v2 for one trial: prepare the folder, start the adapter as its
own process group, enforce the safety-net timeout, sweep leftovers, check the outputs, merge the
proxy's records and label the trial.

The SP3 worker loop wraps this with claiming a trial from the API and uploading what it wrote.
For development and the gate tests it also runs from the command line:

    evals-run-trial --trial-dir runs/t1 --spec spec.json --state client.json=examples/client.json \
        -- python -m my_adapter
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from evals_adapter.adapter import utc_iso
from evals_adapter.proxy import ProxyClient, TrialKey, merge_proxy_spans
from evals_adapter.spec import CONTRACT_VERSION, END_STATES, TRIAL_DIR_ENV, TrialPaths, check_spec

LOG_CAP_BYTES = 50 * 1024 * 1024  # contract section 10
TAG_ENV = "EVALS_TRIAL_TAG"
SCHEMA_DIR_ENV = "EVALS_CONTRACT_DIR"


def safety_net_s(timeout_s: float) -> float:
    """D23: the runner kills the process group at timeout x 1.5 + 30 s."""
    return timeout_s * 1.5 + 30.0


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@dataclass
class TrialInputs:
    spec: dict[str, Any]
    adapter_cmd: list[str]
    state_files: dict[str, bytes] = field(default_factory=dict)
    sim_cache: dict[str, str] | None = None
    env: dict[str, str] = field(default_factory=dict)  # model and simulator keys, adapter extras
    cwd: Path | None = None


def prepare(paths: TrialPaths, inputs: TrialInputs) -> None:
    root = paths.root
    if root.exists() and any(root.iterdir()):
        raise RuntimeError(f"trial folder {root} is not empty; the runner never reuses one")
    for d in (paths.state, paths.harness, paths.home, paths.tmp, paths.out, paths.artifacts):
        d.mkdir(parents=True, exist_ok=True)
    paths.spec.write_text(json.dumps(inputs.spec, ensure_ascii=False, indent=1), encoding="utf-8")
    os.chmod(paths.spec, 0o444)
    for name, data in inputs.state_files.items():
        target = paths.state / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    if inputs.sim_cache is not None:
        paths.sim_cache.write_text(
            json.dumps({"replies": inputs.sim_cache}, ensure_ascii=False), encoding="utf-8"
        )


def _proc_entries() -> list[tuple[int, int, int]]:
    """(pid, pgid, sid) for every visible process, from /proc (Linux)."""
    rows = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            stat = Path(f"/proc/{entry}/stat").read_text()
        except OSError:
            continue
        # comm can contain spaces and parentheses, so split after the last ')'
        rest = stat.rsplit(")", 1)[1].split()
        state, pgid, sid = rest[0], int(rest[2]), int(rest[3])
        if state == "Z":
            continue
        rows.append((int(entry), pgid, sid))
    return rows


def _has_tag(pid: int, tag: str) -> bool:
    try:
        env = Path(f"/proc/{pid}/environ").read_bytes()
    except OSError:
        return False
    return f"{TAG_ENV}={tag}".encode() in env.split(b"\0")


def sweep(leader: int, tag: str) -> int:
    """Kill every process left from the trial: same process group or session as the adapter, or
    carrying the trial's tag in its environment (D3). Returns how many were killed."""
    me = os.getpid()
    victims = set()
    for pid, pgid, sid in _proc_entries():
        if pid == me:
            continue
        if pgid == leader or sid == leader or _has_tag(pid, tag):
            victims.add(pid)
    return kill_all(victims)


def kill_all(victims: set[int]) -> int:
    """SIGKILL every pid in `victims` and wait up to 5 s for them to die. Returns how many."""
    killed = len(victims)
    for pid in victims:
        with contextlib.suppress(ProcessLookupError):
            os.kill(pid, signal.SIGKILL)
    deadline = time.time() + 5
    while victims and time.time() < deadline:
        victims = {p for p in victims if Path(f"/proc/{p}").exists() and not _is_zombie(p)}
        if victims:
            time.sleep(0.05)
    return killed


def _is_zombie(pid: int) -> bool:
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0] == "Z"
    except OSError:
        return True


def launch(
    paths: TrialPaths,
    inputs: TrialInputs,
    net_s: float,
    on_spawn: Callable[[subprocess.Popen], None] | None = None,
) -> dict[str, Any]:
    """Start the adapter as its own process group and wait for it, up to the safety net.
    `on_spawn` gets the process as soon as it exists, so the SP3 worker can kill the group when
    the API says the claim is lost."""
    tag = f"{inputs.spec['trial']['id']}-{uuid.uuid4().hex[:8]}"
    env = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "LANG": "C.UTF-8",
        "HOME": str(paths.home),
        "TMPDIR": str(paths.tmp),
        TRIAL_DIR_ENV: str(paths.root),
        TAG_ENV: tag,
        "PYTHONUNBUFFERED": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    env.update(inputs.env)
    started = time.time()
    with open(paths.stdout_log, "wb") as out, open(paths.stderr_log, "wb") as err:
        proc = subprocess.Popen(  # noqa: S603
            inputs.adapter_cmd,
            stdin=subprocess.DEVNULL,
            stdout=out,
            stderr=err,
            env=env,
            cwd=str(inputs.cwd or paths.home),
            start_new_session=True,
        )
        if on_spawn is not None:
            on_spawn(proc)
        killed = None
        try:
            code: int | None = proc.wait(timeout=net_s)
        except subprocess.TimeoutExpired:
            killed = "SIGKILL"
            with contextlib.suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
            code = None
    # Whatever is still alive from the trial after the adapter exited is killed and counted.
    leftovers = sweep(proc.pid, tag)
    return {
        "exit_code": code,
        "signal": killed,
        "leftover_processes": leftovers,
        "started": started,
        "ended": time.time(),
    }


def _schemas() -> dict[str, Any] | None:
    try:
        import jsonschema  # noqa: F401
    except ImportError:
        return None
    base = os.environ.get(SCHEMA_DIR_ENV)
    candidates = [Path(base)] if base else []
    here = Path(__file__).resolve()
    candidates += [p / "contract" / "v2" for p in here.parents]
    for c in candidates:
        if (c / "result.schema.json").exists():
            return {
                name: json.loads((c / f"{name}.schema.json").read_text())
                for name in ("result", "span", "runner-report")
            }
    return None


def validate(paths: TrialPaths) -> dict[str, Any]:
    """Check result.json and every span. Uses the contract's JSON Schemas when jsonschema and
    the contract folder are available, and a structural check otherwise."""
    schemas = _schemas()
    result_errors: list[str] = []
    trace_errors: list[str] = []
    result: dict[str, Any] | None = None
    if not paths.result.exists():
        result_errors.append("result.json missing")
    else:
        try:
            result = json.loads(paths.result.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            result_errors.append(f"result.json is not JSON: {exc}")
    if result is not None:
        if schemas:
            import jsonschema

            v = jsonschema.Draft202012Validator(schemas["result"])
            result_errors += [
                f"{list(e.absolute_path)}: {e.message}" for e in v.iter_errors(result)
            ]
        else:
            if result.get("contract_version") != CONTRACT_VERSION:
                result_errors.append("contract_version mismatch")
            if result.get("end_state") not in END_STATES:
                result_errors.append(f"unknown end_state {result.get('end_state')!r}")
    if paths.trace.exists():
        span_validator = None
        if schemas:
            import jsonschema

            span_validator = jsonschema.Draft202012Validator(schemas["span"])
        for n, line in enumerate(paths.trace.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            try:
                span = json.loads(line)
            except json.JSONDecodeError as exc:
                trace_errors.append(f"line {n}: not JSON: {exc}")
                continue
            if span_validator is not None:
                trace_errors += [
                    f"line {n} {list(e.absolute_path)}: {e.message}"
                    for e in span_validator.iter_errors(span)
                ]
    else:
        trace_errors.append("trace.jsonl missing")
    return {
        "result": result if not result_errors else None,
        "raw_result": result,
        "result_errors": result_errors,
        "trace_errors": trace_errors,
        "schema_checked": schemas is not None,
    }


def _harness_calls(paths: TrialPaths) -> int:
    """The adapter's own count of model calls, as the floor for the proxy's (0 if unknown)."""
    try:
        result = json.loads(paths.result.read_text(encoding="utf-8"))
        return int(result["counts"]["model_calls"])
    except (OSError, ValueError, KeyError, TypeError):
        return 0


# D26: which provider 400s are the agent's outcome and which are the platform's setup. Both are
# matched against the error the adapter reported (end_detail), case-insensitively; the context
# check runs first. A 400 that matches neither stays the agent's outcome, as before D26.
CONTEXT_TOO_LONG = re.compile(
    r"prompt is too long|context[ _-]?length|context[ _-]?window|maximum context"
    r"|input token count|too many input tokens|input is too long",
    re.IGNORECASE,
)
SETUP_400 = re.compile(
    # authentication and the account: a key, its workspace or its permissions
    r"api[ _-]?key|workspace|authenticat|unauthori[sz]ed|permission"
    # an unknown model
    r"|(unknown|invalid|unsupported) model|model[^.]{0,60}(not found|does not exist|not available)"
    # a rejected or unsupported parameter
    r"|deprecated for this model|unsupported (parameter|value|argument)|not supported"
    r"|does not support|extra inputs are not permitted|unrecognized request argument"
    r"|maximum allowed number of output tokens",
    re.IGNORECASE,
)
CONFIG_STATUSES = ("401", "403", "404")


def _error_text(result: dict[str, Any]) -> str:
    detail = result.get("end_detail") or {}
    parts = (detail.get("harness_stop_reason"), detail.get("exception_message"))
    return " ".join(str(p) for p in parts if p)


def provider_label(last_status: str | None, result: dict[str, Any]) -> str | None:
    """D26: the infra label for a `harness_error`, from LiteLLM's last status for the agent key
    and the error the adapter reported, or None when the ending stays the agent's outcome.

    - budget stop: infra:budget_net;
    - 429 or 5xx: infra:provider_error (the API re-queues it once);
    - 408, LiteLLM's per-call timeout: infra:provider_error too (D16: a call LiteLLM retried
      that still fails is infra);
    - 401, 403, 404: infra:config_error (the API never re-queues it and pauses the experiment);
    - 400: a context-too-long error stays the agent's; one about the request setup (auth, an
      unknown model, a rejected or unsupported parameter) is infra:config_error; any other 400
      stays the agent's.
    By the time a status reaches here LiteLLM has already retried it (D16).
    """
    if last_status is None:
        return None
    if last_status == "budget_exceeded":
        return "infra:budget_net"
    if last_status in ("408", "429") or last_status.startswith("5"):
        return "infra:provider_error"
    if last_status in CONFIG_STATUSES:
        return "infra:config_error"
    if last_status == "400":
        text = _error_text(result)
        if CONTEXT_TOO_LONG.search(text):
            return None
        if SETUP_400.search(text):
            return "infra:config_error"
    return None


def label(launch_info: dict[str, Any], checked: dict[str, Any], proxy_usage: dict | None) -> str:
    """Contract section 7, with D26's provider-error labels. A conversation the simulated
    client's failure ended (ended_by sim_error: its call failed or its reply had no text) is
    infra:sim_error whatever the agent key's status, because the agent did not cause it (D26)."""
    if launch_info["signal"] is not None:
        return "infra:timeout_kill"
    result = checked["result"]
    if launch_info["exit_code"] != 0 or result is None:
        return "infra:adapter_crash"
    if (result.get("conversation") or {}).get("ended_by") == "sim_error":
        return "infra:sim_error"
    if result["end_state"] == "harness_error":
        infra = provider_label((proxy_usage or {}).get("last_status"), result)
        if infra is not None:
            return infra
    return "agent"


def cap_log(path: Path) -> dict[str, Any]:
    size = path.stat().st_size if path.exists() else 0
    truncated = size > LOG_CAP_BYTES
    if truncated:
        with open(path, "r+b") as fh:
            fh.truncate(LOG_CAP_BYTES)
            fh.seek(0, os.SEEK_END)
            fh.write(b"\n[evals-runner] log truncated at 50 MB\n")
    data = path.read_bytes() if path.exists() else b""
    return {
        "path": str(path.name),
        "bytes": len(data),
        "sha256": sha256_bytes(data),
        "truncated": truncated,
    }


def manifest(paths: TrialPaths) -> list[dict[str, Any]]:
    rows = []
    for p in sorted(paths.out.rglob("*")):
        if p.is_file() and p != paths.runner_report:
            data = p.read_bytes()
            rows.append(
                {
                    "path": str(p.relative_to(paths.out)),
                    "bytes": len(data),
                    "sha256": sha256_bytes(data),
                }
            )
    return rows


@dataclass
class ProxySettings:
    client: ProxyClient
    budget_usd: float  # the per-trial safety net, set well above the estimate (R10.6)
    sim_budget_usd: float = 0.5


def run_trial(
    trial_dir: Path,
    inputs: TrialInputs,
    proxy: ProxySettings | None = None,
    on_spawn: Callable[[subprocess.Popen], None] | None = None,
) -> dict[str, Any]:
    """Run one trial end to end and return the runner report (also written to the folder).

    With `proxy`, the runner creates the trial's own LiteLLM keys (agent, and simulator if the
    task has one), hands them over in the variables the spec names, merges LiteLLM's records of
    the agent's calls into the trace afterwards, and revokes the keys. Without it, the caller
    puts keys in `inputs.env` and there is no proxy record (unit tests against the fake).
    """
    spec = check_spec(inputs.spec)
    trial_id = spec["trial"]["id"]
    paths = TrialPaths(trial_dir)
    keys: list[TrialKey] = []
    agent_key = sim_key = None
    if proxy is not None:
        agent_key = proxy.client.create_key(
            trial_id, "agent", proxy.budget_usd, [spec["model"]["name"]]
        )
        keys.append(agent_key)
        inputs.env[spec["model"]["api_key_env"]] = agent_key.key
        sim = spec["task"]["client_sim"]
        if sim is not None:
            sim_key = proxy.client.create_key(
                trial_id, "sim", proxy.sim_budget_usd, [sim["model"]["name"]]
            )
            keys.append(sim_key)
            inputs.env[sim["model"]["api_key_env"]] = sim_key.key
    try:
        prepare(paths, inputs)
        net = safety_net_s(float(spec["settings"]["timeout_s"]))
        info = launch(paths, inputs, net, on_spawn)
        proxy_usage = None
        if proxy is not None and agent_key is not None:
            claimed = _harness_calls(paths)
            records, complete = proxy.client.call_records(agent_key.token, expect_at_least=claimed)
            proxy_usage = proxy.client.usage(records, complete)
            merge_proxy_spans(paths, records, trial_id)
            if sim_key is not None:
                sim_records, _ = proxy.client.call_records(sim_key.token, min_wait_s=0.5)
                merge_proxy_spans(paths, sim_records, trial_id, role="sim")
    finally:
        if proxy is not None:
            try:
                proxy.client.revoke(keys)
            except Exception as exc:  # noqa: BLE001
                print(f"[evals-runner] could not revoke trial keys: {exc}", file=sys.stderr)
    checked = validate(paths)
    report = {
        "contract_version": CONTRACT_VERSION,
        "trial_id": inputs.spec["trial"]["id"],
        "attempt": inputs.spec["trial"].get("attempt", 1),
        "harness": (checked["raw_result"] or {}).get("harness", {}).get("name", "unknown"),
        "label": label(info, checked, proxy_usage),
        "end_state": (checked["result"] or {}).get("end_state"),
        "adapter": {
            "exit_code": info["exit_code"],
            "signal": info["signal"],
            "result_valid": not checked["result_errors"],
            "result_errors": checked["result_errors"][:50],
            "trace_valid": not checked["trace_errors"],
            "trace_errors": checked["trace_errors"][:50],
            "leftover_processes": info["leftover_processes"],
        },
        "proxy_usage": proxy_usage,
        "logs": {"stdout": cap_log(paths.stdout_log), "stderr": cap_log(paths.stderr_log)},
        "files": [],
        "timing": {
            "started_at": utc_iso(info["started"]),
            "ended_at": utc_iso(info["ended"]),
            "wall_s": round(info["ended"] - info["started"], 3),
            "safety_net_s": net,
        },
    }
    report["files"] = manifest(paths)
    paths.runner_report.write_text(
        json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    return report


def _kv(items: list[str]) -> dict[str, str]:
    out = {}
    for item in items:
        k, _, v = item.partition("=")
        if not k or not _:
            raise SystemExit(f"expected NAME=VALUE, got {item!r}")
        out[k] = v
    return out


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Run one contract v2 trial.")
    parser.add_argument("--trial-dir", required=True, type=Path)
    parser.add_argument("--spec", required=True, type=Path)
    parser.add_argument("--state", action="append", default=[], help="NAME=PATH into /trial/state")
    parser.add_argument("--env", action="append", default=[], help="NAME=VALUE for the adapter")
    parser.add_argument("--sim-cache", type=Path, help="JSON file {key: reply}")
    parser.add_argument("--proxy-url", help="LiteLLM base URL; with it the runner makes trial keys")
    parser.add_argument("--proxy-master-key-env", default="LITELLM_MASTER_KEY")
    parser.add_argument("--budget-usd", type=float, default=1.0)
    parser.add_argument("adapter_cmd", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    cmd = args.adapter_cmd[1:] if args.adapter_cmd[:1] == ["--"] else args.adapter_cmd
    if not cmd:
        parser.error("give the adapter command after --")
    spec = json.loads(args.spec.read_text())
    state = {k: Path(v).read_bytes() for k, v in _kv(args.state).items()}
    sim_cache = json.loads(args.sim_cache.read_text()) if args.sim_cache else None
    inputs = TrialInputs(
        spec=spec, adapter_cmd=cmd, state_files=state, sim_cache=sim_cache, env=_kv(args.env)
    )
    proxy = None
    if args.proxy_url:
        master = os.environ.get(args.proxy_master_key_env)
        if not master:
            parser.error(f"{args.proxy_master_key_env} is not set")
        proxy = ProxySettings(ProxyClient(args.proxy_url, master), args.budget_usd)
    report = run_trial(args.trial_dir.resolve(), inputs, proxy)
    json.dump(
        {k: report[k] for k in ("trial_id", "label", "end_state", "adapter")}, sys.stdout, indent=1
    )
    print()
    sys.exit(0 if report["label"] == "agent" else 1)


if __name__ == "__main__":
    main()
