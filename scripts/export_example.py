"""Export one finished experiment as a shipped example, examples/<name>/ (SP7).

Run (it only sends GET requests to the API, so it never changes anything there):

  python3 scripts/export_example.py <experiment_id> --name <slug> --title "<one line>" \\
      [--description "<a few sentences>"] [--api http://127.0.0.1:3001/api] \\
      [--out examples] [--replace]

It writes three files, which the API loads with POST /api/examples/<name>/load:

  manifest.json   title, description, the experiment id, dates, commits, counts, part hashes
  rows.json.gz    every row needed to recreate the experiment (GET /api/experiments/:id/bundle)
  files.jsonl.gz  each trial's stored files, as GET /api/trials/:id/files/<path> serves them

Rows come from GET /experiments/:id/bundle. An API from before that route has none, so the rows
are then assembled from the routes it does have and the repo's catalogue files (tasks/, configs/),
with every content hash checked; what that cannot recover exactly is listed in the manifest's
`approximations` (`--source` forces one way or the other).

Secrets: LiteLLM keys and key tokens, Authorization values, the worker token, the master key and
the values of secret-looking variables in the environment or the repo's .env are scrubbed wherever
they appear. Then a separate check reads everything about to be written and fails the export,
writing nothing, if any `sk-...` key, Bearer token, known secret value or non-empty secret field
is left. Standard library only; Python 3.11 or later.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import gzip
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
DEFAULT_API = "http://127.0.0.1:3001/api"

FORMAT = "agent-evals-example"
FORMAT_VERSION = 1
ROWS_PART = "rows.json.gz"
FILES_PART = "files.jsonl.gz"
NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
TABLES = (
    "prompts",
    "toolsets",
    "tasks",
    "configs",
    "experiments",
    "experiment_arms",
    "experiment_events",
    "trials",
    "spans",
    "grading_jobs",
    "grades",
)
FINAL_TRIAL = {"done", "infra_failed", "abandoned", "cancelled"}

# ---- secrets ----

SK_KEY = re.compile(r"sk-[A-Za-z0-9_-]{8,}")
BEARER = re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}")
PATTERNS = {"litellm_key": SK_KEY, "bearer_token": BEARER}
#: Field names whose value is a secret, wherever they appear (matched lower-case, whole name).
#: `api_key_env` (a variable's name) and `input_tokens` are not among them.
SECRET_FIELDS = frozenset(
    {
        "authorization",
        "proxy-authorization",
        "x-api-key",
        "api-key",
        "api_key",
        "apikey",
        "user_api_key",
        "user_api_key_hash",
        "hashed_token",
        "token",
        "key_token",
        "agent_key_token",
        "sim_key_token",
        "master_key",
        "litellm_master_key",
        "worker_token",
        "evals_worker_token",
        "password",
        "client_secret",
        "access_token",
        "refresh_token",
        "secret_key",
    }
)
#: Compose's out-of-the-box secrets (docker-compose.yml): the master key, the worker token and
#: Postgres's password. Real ones come from the environment or .env (SECRET_ENV).
DEFAULT_SECRETS = ("sk-local-dev-only", "wt-local-dev-only", "evals-local")
SECRET_ENV = re.compile(r"(KEY|TOKEN|PASSWORD|SECRET)$")
SCRUBBED = "[scrubbed]"


def secret_values(env: dict[str, str], dotenv: Path | None) -> set[str]:
    """Values to scrub: compose's defaults and every secret-looking variable's value."""
    found = set(DEFAULT_SECRETS)
    pairs = list(env.items())
    if dotenv is not None and dotenv.is_file():
        for line in dotenv.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                pairs.append((k.strip().removeprefix("export ").strip(), v.strip().strip("'\"")))
    for k, v in pairs:
        if SECRET_ENV.search(k.upper()) and len(v) >= 6:
            found.add(v)
    return found


class Scrubber:
    """Removes secrets from rows and file contents, counting what it changed."""

    def __init__(self, literals: set[str]):
        self.literals = sorted((s for s in literals if len(s) >= 6), key=len, reverse=True)
        self.fields = 0
        self.texts = 0

    def text(self, s: str) -> str:
        out = s
        for lit in self.literals:
            out = out.replace(lit, SCRUBBED)
        out = SK_KEY.sub("sk-" + SCRUBBED, out)
        out = BEARER.sub("Bearer " + SCRUBBED, out)
        if out != s:
            self.texts += 1
        return out

    def value(self, v: Any) -> Any:
        if isinstance(v, dict):
            out = {}
            for k, val in v.items():
                if k.lower() in SECRET_FIELDS and val not in (None, ""):
                    self.fields += 1
                    out[k] = None
                else:
                    out[k] = self.value(val)
            return out
        if isinstance(v, list):
            return [self.value(x) for x in v]
        if isinstance(v, str):
            return self.text(v)
        return v

    def file(self, path: str, data: bytes) -> bytes:
        """The file's bytes with secrets removed; unchanged bytes when there were none."""
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            return data  # not text: the check reports any key in it, nothing is guessed
        before = (self.fields, self.texts)
        if path.endswith(".jsonl"):
            lines = []
            for line in text.split("\n"):
                parsed = _json_or_none(line)
                if parsed is None:
                    lines.append(self.text(line))
                else:
                    clean = self.value(parsed)
                    lines.append(line if clean == parsed else json.dumps(clean, ensure_ascii=False))
            out = "\n".join(lines)
        elif path.endswith(".json") and (parsed := _json_or_none(text)) is not None:
            clean = self.value(parsed)
            out = (
                text if clean == parsed else json.dumps(clean, ensure_ascii=False, indent=2) + "\n"
            )
        else:
            out = self.text(text)
        return data if (self.fields, self.texts) == before else out.encode("utf-8")


def _json_or_none(text: str) -> Any:
    if not text.strip():
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


def _mask(s: str) -> str:
    return s[:6] + "..." if len(s) > 6 else "..."


def find_secrets(tables: dict[str, list], files: list[dict], literals: set[str]) -> list[str]:
    """Every place a secret survives in what would be written: the check that gates the export."""
    lits = [s for s in literals if len(s) >= 6]
    problems: list[str] = []

    def scan_text(where: str, s: str) -> None:
        for name, rx in PATTERNS.items():
            for m in rx.finditer(s):
                if SCRUBBED not in m.group(0):
                    problems.append(f"{where}: a {name} ({_mask(m.group(0))})")
        problems.extend(f"{where}: a known secret value ({_mask(lit)})" for lit in lits if lit in s)

    def walk(where: str, v: Any) -> None:
        if isinstance(v, dict):
            for k, val in v.items():
                if k.lower() in SECRET_FIELDS and val not in (None, ""):
                    problems.append(f"{where}.{k}: a secret field with a value")
                walk(f"{where}.{k}", val)
        elif isinstance(v, list):
            for i, x in enumerate(v):
                walk(f"{where}[{i}]", x)
        elif isinstance(v, str):
            scan_text(where, v)

    for table, rows in tables.items():
        for i, row in enumerate(rows):
            walk(f"{table}[{i}]", row)
    for f in files:
        where = f"file {f['trial_id']}/{f['path']}"
        data = f["data"]
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            scan_text(where, data.decode("latin-1"))
            continue
        scan_text(where, text)
        docs = text.split("\n") if f["path"].endswith(".jsonl") else [text]
        for j, doc in enumerate(docs):
            parsed = _json_or_none(doc)
            if isinstance(parsed, (dict, list)):
                walk(f"{where}" + (f" line {j + 1}" if len(docs) > 1 else ""), parsed)
    return problems


# ---- the API ----


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.code = code


class Api:
    """GET requests only."""

    def __init__(self, base: str):
        self.base = base.rstrip("/")

    def raw(self, path: str) -> bytes:
        try:
            with urllib.request.urlopen(self.base + path, timeout=120) as r:
                return r.read()
        except urllib.error.HTTPError as err:
            body = err.read()
            parsed = _json_or_none(body.decode("utf-8", "replace")) or {}
            code = parsed.get("error", "http_error") if isinstance(parsed, dict) else "http_error"
            msg = parsed.get("message", "") if isinstance(parsed, dict) else ""
            raise ApiError(err.code, str(code), str(msg)) from None

    def json(self, path: str) -> Any:
        return json.loads(self.raw(path))

    def file(self, trial_id: str, rel: str) -> bytes:
        quoted = "/".join(urllib.parse.quote(part, safe="") for part in rel.split("/"))
        return self.raw(f"/trials/{urllib.parse.quote(trial_id, safe='')}/files/{quoted}")


def fetch_bundle(api: Api, exp_id: str) -> dict | None:
    """The exact rows, or None when this API has no bundle route (one built before it)."""
    try:
        return api.json(f"/experiments/{urllib.parse.quote(exp_id, safe='')}/bundle")
    except ApiError as err:
        if err.status == 404 and err.code == "not_found":
            return None
        raise


# ---- assembling the rows from an API without /bundle ----

STORED_EVENTS = {
    "paused",
    "resumed",
    "arm_paused",
    "arm_resumed",
    "futility_pause",
    "infra_guard_pause",
    "spend_guard_pause",
    "baseline",
}

ASSEMBLED_APPROXIMATIONS = [
    "rows assembled from an API without GET /experiments/:id/bundle; every content hash "
    "(tasks, prompts, toolsets, capabilities) was checked against the catalogue files it came from",
    "grading_jobs: only each trial's latest finished job; its graders and grader_files are empty, "
    "claims is 1, worker_id, claimed_at and lease_until are null (that API does not serve them)",
    "grades: spec_sha256 null; framework_version and job_id are the job's",
    "experiment_arms: resumed_at and futility_checked_at null",
    "experiment_events: data {}",
    "experiments: cancelled_at, resumed_at and spend_guard_at from the events list",
    "trials: seq rebuilt from the plan order (repeat, task, config), reported_at = finished_at, "
    "keys_revoked_at null",
    "prompts, toolsets and tasks: first_seen_at is the load time",
]


class Unexportable(Exception):
    pass


def _sha_ref(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def capabilities_from_git(repo: Path, sha: str) -> dict | None:
    """The capabilities file whose bytes have this sha256, from any commit that changed one."""
    for path in sorted(repo.glob("workers/*/src/*/capabilities.json")):
        rel = path.relative_to(repo).as_posix()
        log = subprocess.run(
            ["git", "-C", str(repo), "log", "--format=%H", "--", rel],
            capture_output=True,
            text=True,
            timeout=30,
        )
        for commit in log.stdout.split():
            shown = subprocess.run(
                ["git", "-C", str(repo), "show", f"{commit}:{rel}"], capture_output=True, timeout=30
            )
            if shown.returncode == 0 and _sha_ref(shown.stdout) == sha:
                return json.loads(shown.stdout.decode("utf-8"))
    return None


def canonical(value: Any) -> str:
    """The API's canonical JSON (common/hashing.ts) for plain strings, lists and objects."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def toolset_from_specs(sha: str, views: Any) -> dict | None:
    """A toolset stored before 4 Nov hashed {id, version, servers} only (no manifest). Each
    trial's spec names its toolset and servers, so the row is rebuilt and its hash checked."""
    for v in views:
        tools = (v.get("spec") or {}).get("tools") or {}
        ref = tools.get("toolset") or {}
        if "sha256:" + str(ref.get("sha256", "")).removeprefix("sha256:") != sha:
            continue
        servers = [
            {"name": s["name"], "allowed_tools": s["allowed_tools"]}
            for s in tools.get("mcp_servers") or []
        ]
        content = {"id": ref.get("id"), "version": ref.get("version"), "servers": servers}
        if _sha_ref(canonical(content).encode("utf-8")) == sha:
            return {**content, "manifest": None}
    return None


def _event_at(events: list[dict], kind: str) -> str | None:
    times = [e["at"] for e in events if e["kind"] == kind]
    return max(times) if times else None


def assemble(api: Api, exp_id: str, repo: Path) -> dict[str, list]:
    """The bundle's tables from the routes an API has without /bundle, or Unexportable."""
    q = urllib.parse.quote(exp_id, safe="")
    d = api.json(f"/experiments/{q}")
    summaries = api.json(f"/experiments/{q}/trials")
    views = {s["id"]: api.json(f"/trials/{s['id']}") for s in summaries}
    # Since 5 Nov the export's `grades` are the current grading's only and `grade_history` holds
    # every version; an older API has `grades` alone, holding every version.
    every_grade = {
        t["id"]: t.get("grade_history", t["grades"])
        for t in api.json(f"/experiments/{q}/export?format=json")["trials"]
    }
    events = d["events"]

    if any(a["reused_trials"] for a in d["arms"]):
        raise Unexportable("an arm reuses its parent's trials; only /bundle could export those")
    sim = d["sim"]
    experiment = {
        "id": d["id"],
        "name": d["name"],
        "axis": d["axis"],
        "config_hashes": d["config_hashes"],
        "task_sha256s": d["task_sha256s"],
        "n": d["n"],
        "sim_model": d["sim_model"],
        "sim_prompt_sha256": sim["prompt"]["sha256"] if sim else None,
        "sim_temperature": sim["temperature"] if sim else None,
        "sim_max_output_tokens": sim["max_output_tokens"] if sim else None,
        "budget_usd": d["budget_usd"],
        "trial_budget_usd": d["budgets"]["trial_usd"],
        "sim_budget_usd": d["budgets"]["sim_usd"],
        "platform_commit": d["platform_commit"],
        "plan_commit": d["plan_commit"],
        "estimate": d["estimate"],
        "status": d["status"],
        "created_at": d["created_at"],
        "started_at": d["started_at"],
        "finished_at": d["finished_at"],
        "cancelled_at": _event_at(events, "cancelled"),
        "paused_at": d["paused_at"],
        "paused_reason": d["paused_reason"],
        "resumed_at": _event_at(events, "resumed"),
        "parent_experiment_id": d["parent_experiment_id"],
        "reuse_baseline": d["baseline"] is not None,
        "baseline_decision": d["baseline"]["reason"] if d["baseline"] else None,
        "order_seed": d["order_seed"],
        "futility": d["futility"],
        "spend_guard_at": _event_at(events, "spend_guard_pause"),
    }
    arms = [
        {
            "experiment_id": exp_id,
            "config_hash": a["config_hash"],
            "arm": a["arm"],
            "position": i,
            "reused_trial_ids": [],
            "paused_at": a["paused_at"],
            "paused_reason": a["paused_reason"],
            "paused_fix": a["fix"],
            "resumed_at": None,
            "futility_checked_at": None,
        }
        for i, a in enumerate(d["arms"])
    ]
    stored_events = [
        {
            "experiment_id": exp_id,
            "at": e["at"],
            "kind": e["kind"],
            "config_hash": e["config_hash"],
            "trial_id": e["trial_id"],
            "attempt": e["attempt"],
            "detail": e["detail"],
            "data": {},
        }
        for e in reversed(events)
        if e["kind"] in STORED_EVENTS
    ]

    # Configs: the view, plus what it leaves out, from the capabilities it was validated against
    # (the current file, or an earlier version of it from git, found by its sha256).
    harnesses = {h["name"]: h for h in api.json("/harnesses")}
    configs, todo, seen = [], list(d["config_hashes"]), set()
    while todo:
        h = todo.pop(0)
        if h in seen:
            continue
        seen.add(h)
        c = api.json(f"/configs/{urllib.parse.quote(h, safe='')}")
        harness = harnesses.get(c["harness"])
        if harness is None:
            raise Unexportable(f"config {h}: GET /harnesses has no {c['harness']} now")
        if harness["capabilities_sha256"] == c["capabilities_sha256"]:
            capabilities = harness["capabilities"]
        else:
            capabilities = capabilities_from_git(repo, c["capabilities_sha256"])
        if capabilities is None:
            raise Unexportable(
                f"config {h}: capabilities {c['capabilities_sha256']} are neither the current "
                "file nor any version of a workers/*/src/*/capabilities.json in git"
            )
        formats = capabilities.get("model_api_formats") or []
        configs.append(
            {
                "hash": c["hash"],
                "name": c["name"],
                "harness": c["harness"],
                "harness_package": harness["package"],
                "harness_ref": c["harness_ref"],
                "adapter_version": c["adapter_version"],
                "capabilities_sha256": c["capabilities_sha256"],
                "capabilities": capabilities,
                "model": c["model"],
                "api_format": "openai_chat"
                if "openai_chat" in formats
                else (formats or ["openai_chat"])[0],
                "prompt_sha256": c["prompt"]["sha256"],
                "toolset_sha256": c["toolset"]["sha256"],
                "settings": c["settings"],
                "settings_sources": c["settings_sources"],
                "harness_options": c["harness_options"],
                "seed": c["seed"],
                "parent_hash": c["parent_hash"],
                "created_at": c["created_at"],
            }
        )
        if c["parent_hash"]:
            todo.append(c["parent_hash"])

    prompts_by_sha = {p["sha256"]: p for p in api.json("/prompts")}
    wanted = {c["prompt_sha256"] for c in configs} | (
        {experiment["sim_prompt_sha256"]} if experiment["sim_prompt_sha256"] else set()
    )
    prompts = []
    for sha in sorted(wanted):
        p = prompts_by_sha.get(sha)
        if p is None:
            raise Unexportable(f"prompt {sha} is not in configs/prompts now")
        prompts.append(
            {
                "sha256": sha,
                "id": p["id"],
                "version": p["version"],
                "text": p["text"],
                "path": p["path"],
            }
        )
    toolsets_by_sha = {t["sha256"]: t for t in api.json("/toolsets")}
    toolsets = []
    for sha in sorted({c["toolset_sha256"] for c in configs}):
        t = toolsets_by_sha.get(sha) or toolset_from_specs(sha, views.values())
        if t is None:
            raise Unexportable(
                f"toolset {sha} is neither the finance server's toolset now nor a names-only "
                "toolset a trial's spec rebuilds"
            )
        toolsets.append(
            {
                "sha256": sha,
                "id": t["id"],
                "version": t["version"],
                "servers": t["servers"],
                "manifest": t["manifest"],
            }
        )

    # Tasks: the API's view, with the body and client file from tasks/<dir>/ (the hash is checked).
    files_by_sha: dict[str, Path] = {}
    for task_json in sorted((repo / "tasks").glob("*/task.json")):
        files_by_sha[_sha_ref(task_json.read_bytes())] = task_json
    tasks = []
    for view in d["tasks"]:
        src = files_by_sha.get(view["sha256"])
        if src is None:
            raise Unexportable(f"task {view['id']} ({view['sha256']}) is not in tasks/ any more")
        body = json.loads(src.read_bytes().decode("utf-8"))
        state_name = body.get("client_state") if isinstance(body.get("client_state"), str) else None
        state = (src.parent / state_name).read_bytes() if state_name else None
        tasks.append(
            {
                "sha256": view["sha256"],
                "id": view["id"],
                "version": view["version"],
                "split": view["split"],
                "kind": view["kind"],
                "summary": view["summary"],
                "body": body,
                "client_state_name": state_name,
                "client_state": ("\\x" + state.hex()) if state is not None else None,
                "client_state_sha256": _sha_ref(state) if state is not None else None,
                "source_path": f"tasks/{src.parent.name}/task.json",
            }
        )

    task_order, config_order = d["task_sha256s"], d["config_hashes"]
    trials, spans, jobs, grades = [], [], [], []
    last_seq = -1
    for s in summaries:
        v = views[s["id"]]
        seq = (
            s["repeat_index"] * len(task_order) * len(config_order)
            + task_order.index(s["task_sha256"]) * len(config_order)
            + config_order.index(s["config_hash"])
        )
        if seq < last_seq:
            raise Unexportable("the trial list is not in plan order, so seq cannot be rebuilt")
        last_seq = seq
        usage, timing = v["usage"] or {}, v["timing"]
        reported = v["runner_report"] is not None
        trials.append(
            {
                "id": v["id"],
                "experiment_id": exp_id,
                "task_sha256": s["task_sha256"],
                "config_hash": s["config_hash"],
                "repeat_index": v["repeat_index"],
                "attempt": v["attempt"],
                "seq": seq,
                "order_index": s["order_index"],
                "harness": s["harness"],
                "status": v["status"],
                "worker_id": v["worker_id"],
                "claimed_at": timing["claimed_at"],
                "heartbeat_at": timing["heartbeat_at"],
                "finished_at": timing["finished_at"],
                "reported_at": timing["finished_at"] if reported else None,
                "keys_revoked_at": None,
                "spec": v["spec"],
                "folder": f"{exp_id}/{v['id']}/attempt-{v['attempt']}"
                if timing["claimed_at"]
                else None,
                "label": v["label"],
                "end_state": v["end_state"],
                "runner_report": v["runner_report"],
                "result": v["result"],
                "cost_usd": usage.get("cost_usd"),
                "sim_cost_usd": usage.get("sim_cost_usd"),
                "input_tokens": usage.get("input_tokens"),
                "output_tokens": usage.get("output_tokens"),
                "model_calls": usage.get("model_calls"),
                "proxy_complete": usage.get("complete"),
                "wall_s": timing["wall_s"],
                "files": v["files"] if reported else None,
                "problems": v["problems"],
                "created_at": timing["created_at"],
                "probe": False,
            }
        )
        spans.extend(
            {"trial_id": v["id"], "raw": raw} for raw in api.json(f"/trials/{v['id']}/spans")
        )
        grading = v["grading"]
        if grading["pending"] is not None:
            raise Unexportable(f"trial {v['id']} still has grading {grading['pending']['status']}")
        if len(every_grade.get(v["id"], [])) != len(v["grades"]):
            raise Unexportable(
                f"trial {v['id']} has older grade versions, which only /bundle exports"
            )
        job = grading["current"]
        if job is None:
            continue
        jobs.append(
            {
                "id": job["job_id"],
                "trial_id": v["id"],
                "reason": job["reason"],
                "status": job["status"],
                "task_id": v["task"]["id"],
                "task_sha256": job["task_sha256"],
                "grader_source": job["grader_source"],
                "source_note": job["source_note"],
                "graders": [],
                "grader_files": {},
                "claims": 1 if job["status"] == "done" else 0,
                "worker_id": None,
                "claimed_at": None,
                "lease_until": None,
                "reported_at": job["graded_at"],
                "framework_version": job["framework_version"],
                "passed": job["passed"],
                "outcome": job["outcome"],
                "grade_ids": [g["id"] for g in v["grades"]],
                "problems": [],
                "error": job["error"],
                "created_at": job["queued_at"],
            }
        )
        for g in v["grades"]:
            grades.append(
                {
                    **g,
                    "trial_id": v["id"],
                    "spec_sha256": None,
                    "framework_version": job["framework_version"],
                    "job_id": job["job_id"],
                }
            )
    return {
        "prompts": prompts,
        "toolsets": toolsets,
        "tasks": tasks,
        "configs": configs,
        "experiments": [experiment],
        "experiment_arms": arms,
        "experiment_events": stored_events,
        "trials": trials,
        "spans": spans,
        "grading_jobs": jobs,
        "grades": grades,
    }


# ---- the export ----


def git_head(repo: Path) -> str | None:
    try:
        out = subprocess.run(
            ["git", "-C", str(repo), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except OSError:
        return None
    if out.returncode != 0:
        return None
    return out.stdout.strip() or None


def gz(data: bytes) -> bytes:
    """Gzip with no timestamp, so the same content always gives the same bytes."""
    return gzip.compress(data, compresslevel=9, mtime=0)


def default_description(exp: dict, tables: dict[str, list]) -> str:
    by_hash = {c["hash"]: c for c in tables["configs"]}
    arms = " vs ".join(
        f"{c['harness']} on {c['model']}"
        for c in (by_hash[h] for h in exp["config_hashes"] if h in by_hash)
    )
    statuses: dict[str, int] = {}
    for t in tables["trials"]:
        statuses[t["status"]] = statuses.get(t["status"], 0) + 1
    counted = ", ".join(f"{n} {s}" for s, n in sorted(statuses.items()))
    return (
        f"{exp['name']}: {arms}, {len(exp['task_sha256s'])} tasks, N={exp['n']} per task and arm; "
        f"{len(tables['trials'])} trials ({counted})."
    )


def build(args: argparse.Namespace, api: Api) -> tuple[dict, bytes, bytes, list[dict]]:
    """The manifest and the two parts, checked for secrets. Raises Unexportable."""
    detail = api.json(f"/experiments/{urllib.parse.quote(args.experiment_id, safe='')}")
    if detail["status"] not in ("done", "cancelled"):
        raise Unexportable(
            f"experiment {args.experiment_id} is {detail['status']}; export a finished one"
        )
    live = {k: detail["counts"][k] for k in ("queued", "running") if detail["counts"][k]}
    if live:
        raise Unexportable(f"experiment {args.experiment_id} still has trials {live}")

    source, approximations, schema = args.source, [], None
    bundle = fetch_bundle(api, args.experiment_id) if source in ("auto", "bundle") else None
    if bundle is not None:
        source, tables, schema = "bundle", bundle["tables"], bundle.get("schema_version")
    elif source == "bundle":
        raise Unexportable(
            "this API has no GET /experiments/:id/bundle (rebuild it, or pass --source assembled)"
        )
    else:
        source, tables = "assembled", assemble(api, args.experiment_id, args.repo)
        approximations = list(ASSEMBLED_APPROXIMATIONS)
    tables = {t: tables.get(t, []) for t in TABLES}

    exp = tables["experiments"][0]
    for arm in tables["experiment_arms"]:
        if arm.get("reused_trial_ids"):
            raise Unexportable(
                "an arm reuses its parent's trials, which an example cannot carry yet"
            )
    if exp.get("parent_experiment_id"):
        approximations.append(
            f"parent_experiment_id {exp['parent_experiment_id']} cleared: the parent is not shipped"
        )
        exp["parent_experiment_id"] = None
    exp.pop("litellm_team_id", None)
    for key in ("example_name", "example_title", "example_loaded_at"):
        exp.pop(key, None)  # set by the load, from this manifest
    bad = [t["id"] for t in tables["trials"] if t["status"] not in FINAL_TRIAL]
    if bad:
        raise Unexportable(f"trials {bad[:3]} have not finished")
    for t in tables["trials"]:
        t.pop("agent_key_token", None)
        t.pop("sim_key_token", None)

    # Files, as the API serves them, checked against each trial's manifest.
    files, missing = [], []
    for t in tables["trials"]:
        for f in t.get("files") or []:
            try:
                data = api.file(t["id"], f["path"])
            except ApiError as err:
                if err.status != 404:
                    raise
                missing.append(f"{t['id']}/{f['path']}")
                continue
            if _sha_ref(data) != f["sha256"]:
                raise Unexportable(f"{t['id']}/{f['path']} is not the file its trial lists")
            files.append({"trial_id": t["id"], "path": f["path"], "data": data})

    literals = secret_values(dict(os.environ), args.repo / ".env")
    scrub = Scrubber(literals)
    tables = scrub.value(tables)
    scrubbed_files = []
    for f in files:
        clean = scrub.file(f["path"], f["data"])
        if clean != f["data"]:
            trial = next(t for t in tables["trials"] if t["id"] == f["trial_id"])
            entries = [trial.get("files") or []]
            if isinstance(trial.get("runner_report"), dict):
                entries.append(trial["runner_report"].get("files") or [])
            for listing in entries:
                for entry in listing:
                    if entry.get("path") == f["path"]:
                        entry["bytes"], entry["sha256"] = len(clean), _sha_ref(clean)
            scrubbed_files.append(f"{f['trial_id']}/{f['path']}")
            f["data"] = clean
    problems = find_secrets(tables, files, literals)
    if problems:
        raise Unexportable(
            "secrets survive the scrub, so nothing is written:\n  " + "\n  ".join(problems[:20])
        )

    rows = json.dumps(
        {
            "format": "agent-evals-bundle",
            "format_version": 1,
            "schema_version": schema,
            "experiment_id": args.experiment_id,
            "tables": tables,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    lines = []
    for f in files:
        data = f["data"]
        try:
            content, encoding = data.decode("utf-8"), "utf8"
        except UnicodeDecodeError:
            content, encoding = base64.b64encode(data).decode("ascii"), "base64"
        line = {
            "trial_id": f["trial_id"],
            "path": f["path"],
            "bytes": len(data),
            "sha256": _sha_ref(data),
            "encoding": encoding,
            "content": content,
        }
        lines.append(json.dumps(line, ensure_ascii=False, separators=(",", ":")))
    rows_gz, files_gz = gz(rows), gz(("\n".join(lines) + "\n").encode("utf-8") if lines else b"")

    arms_view = []
    by_hash = {c["hash"]: c for c in tables["configs"]}
    for arm in sorted(tables["experiment_arms"], key=lambda a: a["position"]):
        c = by_hash.get(arm["config_hash"], {})
        arms_view.append(
            {
                "arm": arm["arm"],
                "config_name": c.get("name"),
                "harness": c.get("harness"),
                "model": c.get("model"),
            }
        )
    statuses: dict[str, int] = {}
    for t in tables["trials"]:
        statuses[t["status"]] = statuses.get(t["status"], 0) + 1
    spend = sum((t.get("cost_usd") or 0) + (t.get("sim_cost_usd") or 0) for t in tables["trials"])
    manifest = {
        "format": FORMAT,
        "format_version": FORMAT_VERSION,
        "name": args.name,
        "title": args.title.strip(),
        "description": (args.description or default_description(exp, tables)).strip(),
        "sample": True,
        "experiment_id": args.experiment_id,
        "experiment_name": exp["name"],
        "created_at": exp["created_at"],
        "finished_at": exp.get("finished_at"),
        "exported_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "platform_commit": exp.get("platform_commit"),
        "exported_from_commit": git_head(args.repo),
        "source": source,
        "schema_version": schema,
        "approximations": approximations,
        "summary": {
            "axis": exp["axis"],
            "n": exp["n"],
            "status": exp["status"],
            "arms": arms_view,
            "trials_by_status": statuses,
            "spend_usd": round(spend, 6),
        },
        "counts": {
            "configs": len(tables["configs"]),
            "tasks": len(tables["tasks"]),
            "trials": len(tables["trials"]),
            "spans": len(tables["spans"]),
            "grades": len(tables["grades"]),
            "grading_jobs": len(tables["grading_jobs"]),
            "events": len(tables["experiment_events"]),
            "files": len(files),
            "file_bytes": sum(len(f["data"]) for f in files),
        },
        "missing_files": missing,
        "scrubbed": {"fields": scrub.fields, "texts": scrub.texts, "files": scrubbed_files},
        "secret_check": {
            "passed": True,
            "patterns": {k: rx.pattern for k, rx in PATTERNS.items()},
            "fields": sorted(SECRET_FIELDS),
        },
        "parts": {
            ROWS_PART: {"bytes": len(rows_gz), "sha256": _sha_ref(rows_gz)},
            FILES_PART: {"bytes": len(files_gz), "sha256": _sha_ref(files_gz)},
        },
    }
    return manifest, rows_gz, files_gz, files


def write(
    out_dir: Path, name: str, manifest: dict, rows_gz: bytes, files_gz: bytes, replace: bool
) -> Path:
    """Writes the folder beside its place, then moves it in: a failed export leaves nothing."""
    dest = out_dir / name
    if dest.exists() and not replace:
        raise Unexportable(
            f"{dest} exists; pass --replace to export over it (git keeps the old one)"
        )
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp = out_dir / f".{name}.tmp-{secrets.token_hex(4)}"
    tmp.mkdir()
    (tmp / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    (tmp / ROWS_PART).write_bytes(rows_gz)
    (tmp / FILES_PART).write_bytes(files_gz)
    if dest.exists():
        old = out_dir / f".{name}.old-{secrets.token_hex(4)}"
        dest.rename(old)
        tmp.rename(dest)
        shutil.rmtree(old)
    else:
        tmp.rename(dest)
    return dest


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("experiment_id")
    p.add_argument(
        "--name", required=True, help="the folder name: lower-case letters, digits, hyphens"
    )
    p.add_argument("--title", required=True, help="one line, shown wherever the example is listed")
    p.add_argument(
        "--description", help="a few sentences; a factual one is made from the data if left out"
    )
    p.add_argument("--api", default=DEFAULT_API)
    p.add_argument("--out", type=Path, default=REPO / "examples")
    p.add_argument(
        "--repo", type=Path, default=REPO, help="for tasks/ (assembled rows), .env and the commit"
    )
    p.add_argument("--source", choices=("auto", "bundle", "assembled"), default="auto")
    p.add_argument(
        "--replace", action="store_true", help="export over an existing examples/<name>/"
    )
    args = p.parse_args(argv)
    if not NAME.match(args.name):
        p.error("--name must be lower-case letters, digits and hyphens")
    if not args.title.strip() or "\n" in args.title:
        p.error("--title must be one non-empty line")
    try:
        manifest, rows_gz, files_gz, _ = build(args, Api(args.api))
        dest = write(args.out, args.name, manifest, rows_gz, files_gz, args.replace)
    except (Unexportable, ApiError) as err:
        print(f"export_example: {err}", file=sys.stderr)
        return 1
    size = sum(f.stat().st_size for f in dest.iterdir())
    c = manifest["counts"]
    print(
        f"wrote {dest} ({size / 1024:.0f} KiB: {ROWS_PART} {len(rows_gz) / 1024:.0f} KiB, "
        f"{FILES_PART} {len(files_gz) / 1024:.0f} KiB) from {manifest['source']} rows: "
        f"{c['trials']} trials, {c['spans']} spans, {c['grades']} grades, {c['files']} files "
        f"({c['file_bytes'] / 1024:.0f} KiB before gzip); secrets scrubbed: "
        f"{manifest['scrubbed']['fields']} fields, {manifest['scrubbed']['texts']} texts; "
        "check passed"
    )
    if manifest["missing_files"]:
        print(f"  {len(manifest['missing_files'])} listed files were not stored, so not shipped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
