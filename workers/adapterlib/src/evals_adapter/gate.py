"""Gate tests shared by every harness (contract v2 section 8, R7, R10.5).

A harness counts only once these pass against the fake model server, with no real calls:

1. settings: each supported setting reaches the request with the configured value;
2. steps: a model that never stops calling tools ends in step_limit, within max_steps plus the
   declared extra calls;
3. tools: the first request's tools equal the finance server's manifest, apart from the
   harness's declared name rewrite and description wrapper;
4. timeout: a hung model call ends the trial as timeout within timeout_s plus a margin;
5. errors: a malformed tool call goes back to the model (D18), and a 429 is not retried by the
   harness (R10.11);
6. conversation: a simulated client holds a three-turn conversation;
7. schemas: every output validates (the runner checks this on every gate run).

A harness's tests/test_gate.py builds a `Gate` and calls one method per test. The fake server
and the finance server run from their own project environments, so a harness environment needs
neither installed.
"""

from __future__ import annotations

import hashlib
import json
import os
import socket
import subprocess
import time
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from evals_adapter.runner import ProxySettings, TrialInputs, run_trial
from evals_adapter.trace import attr_dict

REPO = Path(os.environ.get("EVALS_REPO_ROOT", Path(__file__).resolve().parents[4]))
FAKE_DIR = REPO / "services" / "fake-llm"
FINANCE_DIR = REPO / "services" / "finance-mcp"
CLIENT_EXAMPLE = FINANCE_DIR / "examples" / "client.example.json"
TOOLS_SNAPSHOT = FINANCE_DIR / "tests" / "snapshots" / "tools_manifest.json"
ALL_FINANCE_TOOLS = (
    [t["name"] for t in json.loads(TOOLS_SNAPSHOT.read_text())] if TOOLS_SNAPSHOT.exists() else []
)
SIM_PROMPT_FILE = REPO / "configs" / "prompts" / "client-sim.v1.md"
GATE_SYSTEM_PROMPT = (
    "You are a careful personal-finance assistant for clients in India. [gate test]"
)
MODEL_KEY_ENV = "EVALS_MODEL_API_KEY"
SIM_KEY_ENV = "EVALS_SIM_API_KEY"


def prompt_text(path: Path) -> str:
    """A prompt file's text without its leading <!-- review header -->."""
    text = path.read_text(encoding="utf-8")
    if text.startswith("<!--"):
        end = text.find("-->")
        if end != -1:
            text = text[end + 3 :]
    return text.strip() + "\n"


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _bin(project: Path, name: str) -> str:
    path = project / ".venv" / "bin" / name
    if not path.exists():
        raise RuntimeError(f"{path} missing: run `uv sync` in {project}")
    return str(path)


class FakeServer:
    """The fake model server as a subprocess on a free port, with the repo's scripts."""

    def __init__(self) -> None:
        self.port = _free_port()
        self.url = f"http://127.0.0.1:{self.port}/v1"
        env = dict(
            os.environ, FAKE_LLM_PORT=str(self.port), FAKE_LLM_SCRIPTS_DIR=str(FAKE_DIR / "scripts")
        )
        self.proc = subprocess.Popen(  # noqa: S603
            [_bin(FAKE_DIR, "fake-llm")],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        deadline = time.time() + 20
        while time.time() < deadline:
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{self.port}/health", timeout=1)  # noqa: S310
                return
            except OSError:
                time.sleep(0.1)
        self.stop()
        raise RuntimeError("fake model server did not start")

    def _admin(self, method: str, path: str) -> Any:
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method=method)
        with urllib.request.urlopen(req, timeout=5) as resp:  # noqa: S310
            return json.loads(resp.read())

    def requests(self) -> list[dict[str, Any]]:
        """Captured requests, oldest first; each has `body`, `script`, `step`, `fault`."""
        return self._admin("GET", "/_fake/requests")["requests"]

    def reset(self) -> None:
        self._admin("DELETE", "/_fake/requests")
        self._admin("DELETE", "/_fake/faults")

    def stop(self) -> None:
        self.proc.kill()
        self.proc.wait()


@dataclass
class GateRun:
    report: dict[str, Any]
    result: dict[str, Any]
    spans: list[dict[str, Any]]
    requests: list[dict[str, Any]]
    trial_dir: Path
    wall_s: float

    def spans_named(self, prefix: str) -> list[dict[str, Any]]:
        return [s for s in self.spans if s["name"].startswith(prefix)]

    def explain(self) -> str:
        stderr = (self.trial_dir / "out" / "stderr.log").read_text(errors="replace")[-3000:]
        adapter = json.dumps(self.report["adapter"])
        return f"report={adapter} end={self.result.get('end_state')} stderr=...{stderr}"


def unwrap_description(text: Any, wrapper: tuple[str, str] | None) -> Any:
    """`text` without the declared (prefix, suffix) around it. Anything not wrapped in exactly
    that text is returned unchanged, so it still has to match the server's text as sent."""
    if wrapper is None or not isinstance(text, str):
        return text
    prefix, suffix = wrapper
    if len(text) >= len(prefix) + len(suffix) and text.startswith(prefix) and text.endswith(suffix):
        return text[len(prefix) : len(text) - len(suffix)]
    return text


def unwrap_schema_descriptions(schema: Any, wrapper: tuple[str, str] | None) -> Any:
    """A copy of a parameter schema with the declared wrapper taken off every `description`
    string. Every other key and value is left exactly as sent."""
    if isinstance(schema, dict):
        return {
            k: unwrap_description(v, wrapper)
            if k == "description" and isinstance(v, str)
            else unwrap_schema_descriptions(v, wrapper)
            for k, v in schema.items()
        }
    if isinstance(schema, list):
        return [unwrap_schema_descriptions(v, wrapper) for v in schema]
    return schema


@dataclass
class Gate:
    """One harness's gate. `tool_name` maps a finance tool name to what the harness sends
    (Hermes: mcp__finance__<name>). `env` adds variables for the adapter process.

    `description_wrapper` declares the exact (prefix, suffix) a harness puts around every tool
    and parameter description it sends (ADK's untrusted-description markers). D20 keeps that
    text in the request, so the tool test takes off exactly this wrapper before comparing; every
    tool-level description must carry it, and names and schemas must otherwise match exactly.
    Declare it in capabilities.json `known_differences` too."""

    harness: str
    adapter_cmd: list[str]
    capabilities: dict[str, Any]
    tool_name: Callable[[str], str] = lambda name: name
    description_wrapper: tuple[str, str] | None = None
    env: dict[str, str] = field(default_factory=dict)
    cwd: Path | None = None
    # Proxy mode: route every call through LiteLLM (which routes fake/* to the compose fake),
    # let the runner make the trial keys, and read the requests from LiteLLM's records.
    proxy: ProxySettings | None = None
    proxy_base_url: str | None = None

    def base_url(self, fake: FakeServer | None) -> str:
        if self.proxy is not None:
            assert self.proxy_base_url, "proxy mode needs proxy_base_url"
            return self.proxy_base_url
        assert fake is not None, "direct mode needs the fake server"
        return fake.url

    def spec(
        self, trial_dir: Path, script: str, fake: FakeServer, **settings: Any
    ) -> dict[str, Any]:
        caps = self.capabilities["settings"]
        values: dict[str, Any] = {
            "temperature": 0.2,
            "max_output_tokens": 1024,
            "max_steps": 10,
            "timeout_s": 60,
            "parallel_tool_calls": False,
            "memory": {"enabled": False},
            "skills": {"enabled": False},
            "compression": {"enabled": False},
        }
        values.update(settings)
        sources = {}
        for name in list(values):
            if not caps[name]["supported"]:
                values[name] = None
                sources[name] = "unsupported"
            else:
                sources[name] = "config" if name in settings else "platform_default"
        finance = [
            _bin(FINANCE_DIR, "finance-mcp"),
            "--transport",
            "stdio",
            "--state-dir",
            str(trial_dir / "state"),
        ]
        return {
            "contract_version": "2",
            "trial": {
                "id": f"gate-{self.harness}-{script}-{os.urandom(3).hex()}",
                "experiment_id": None,
                "config_id": f"gate-{self.harness}",
                "config_hash": "sha256:" + _sha(json.dumps(values, sort_keys=True)),
                "task_id": f"gate-{script}",
                "task_version": "sha256:" + _sha(script),
                "task_split": None,
                "repeat_index": 0,
                "attempt": 1,
            },
            "task": {
                "messages": [
                    {"role": "user", "content": "What is my EMI on Rs 10 lakh at 9% for 20 years?"}
                ],
                "client_sim": None,
            },
            "system_prompt": {
                "id": "gate",
                "version": "gate-1",
                "sha256": _sha(GATE_SYSTEM_PROMPT),
                "text": GATE_SYSTEM_PROMPT,
            },
            "model": {
                "name": f"fake/{script}",
                "base_url": self.base_url(fake),
                "api_key_env": MODEL_KEY_ENV,
                "api_format": "openai_chat",
            },
            "settings": values,
            "settings_sources": sources,
            "harness_options": {},
            "tools": {
                "toolset": {
                    "id": "finance",
                    "version": "all",
                    "sha256": _sha(",".join(ALL_FINANCE_TOOLS)),
                },
                "mcp_servers": [
                    {
                        "name": "finance",
                        "command": finance,
                        "allowed_tools": list(ALL_FINANCE_TOOLS),
                        "tool_timeout_s": 30,
                    }
                ],
                "enabled_builtins": [],
            },
            "seed": {"memory": [], "skills": []},
        }

    def run(self, tmp_path: Path, fake: FakeServer | None, spec: dict[str, Any]) -> GateRun:
        if fake is not None and self.proxy is None:
            fake.reset()
        trial_dir = tmp_path / "trial"
        env = {MODEL_KEY_ENV: "sk-fake-gate", SIM_KEY_ENV: "sk-fake-sim"}
        env.update(self.env)
        started = time.time()
        report = run_trial(
            trial_dir,
            TrialInputs(
                spec=spec,
                adapter_cmd=self.adapter_cmd,
                state_files={"client.json": CLIENT_EXAMPLE.read_bytes()},
                env=env if self.proxy is None else dict(self.env),
                cwd=self.cwd,
            ),
            self.proxy,
        )
        wall = time.time() - started
        out = trial_dir / "out"
        result = (
            json.loads((out / "result.json").read_text()) if (out / "result.json").exists() else {}
        )
        spans = []
        if (out / "trace.jsonl").exists():
            spans = [
                json.loads(line) for line in (out / "trace.jsonl").read_text().splitlines() if line
            ]
        requests = proxy_requests(trial_dir, spans) if self.proxy is not None else fake.requests()
        return GateRun(report, result, spans, requests, trial_dir, wall)

    def agent_requests(self, run: GateRun) -> list[dict[str, Any]]:
        return [r for r in run.requests if not r["script"].startswith("sim-")]

    # ---- the gate tests ------------------------------------------------------------------

    def check_proxy_records(self, run: GateRun) -> None:
        """Proxy mode: LiteLLM logged every agent call, priced, with its bodies (R10.9)."""
        usage = run.report["proxy_usage"]
        assert usage is not None, "no proxy records"
        agent_chats = [
            s for s in run.spans_named("chat ") if attr_dict(s).get("evals.role") == "agent"
        ]
        assert usage["model_calls"] == len(agent_chats) >= 1, (usage, len(agent_chats))
        assert usage["cost_usd"] > 0, usage
        turn_ids = {s["spanId"] for s in run.spans_named("agent.turn")}
        assert all(s.get("parentSpanId") in turn_ids for s in agent_chats), (
            "chat span outside a turn"
        )
        assert usage["complete"], "LiteLLM's log had fewer calls than the harness reported"
        cut = [
            s["name"] for s in run.spans_named("chat ") if attr_dict(s)["evals.request.truncated"]
        ]
        assert not cut, "LiteLLM stored cut-short bodies: set MAX_STRING_LENGTH_PROMPT_IN_DB"

    def check_schemas(self, run: GateRun) -> None:
        adapter = run.report["adapter"]
        assert adapter["result_valid"], adapter["result_errors"]
        assert adapter["trace_valid"], adapter["trace_errors"]

    def test_answer(self, tmp_path: Path, fake: FakeServer) -> GateRun:
        """One finance tool call, then an answer: the end-to-end path."""
        run = self.run(tmp_path, fake, self.spec(tmp_path / "trial", "finance-emi", fake))
        assert run.report["label"] == "agent", run.explain()
        self.check_schemas(run)
        assert run.result["end_state"] == "answered", run.explain()
        assert "8,997" in (run.result["final_answer"] or "")
        assert run.result["counts"]["tool_calls"] == 1
        (tool,) = run.spans_named("execute_tool")
        assert attr_dict(tool)["evals.tool.is_error"] is False, attr_dict(tool)
        assert "8997.26" in attr_dict(tool)["evals.tool.result"]
        assert len(self.agent_requests(run)) == 2
        system = self.agent_requests(run)[0]["body"]["messages"][0]
        assert system["role"] in ("system", "developer")
        assert GATE_SYSTEM_PROMPT in _text(system["content"])
        return run

    def test_settings(self, tmp_path: Path, fake: FakeServer) -> GateRun:
        caps = self.capabilities["settings"]
        wanted = {"temperature": 0.37, "max_output_tokens": 777, "parallel_tool_calls": False}
        settings = {k: v for k, v in wanted.items() if caps[k]["supported"]}
        run = self.run(
            tmp_path, fake, self.spec(tmp_path / "trial", "finance-emi", fake, **settings)
        )
        self.check_schemas(run)
        assert run.result["end_state"] == "answered", run.explain()
        wire = {
            "temperature": "temperature",
            "max_output_tokens": "max_tokens",
            "parallel_tool_calls": "parallel_tool_calls",
        }
        for req in self.agent_requests(run):
            body = req["body"]
            for name, value in wanted.items():
                key = wire[name]
                if caps[name]["supported"]:
                    sent = body.get(
                        key, body.get("max_completion_tokens") if key == "max_tokens" else None
                    )
                    assert sent == value, f"{name}: sent {sent!r}, configured {value!r}"
                    assert run.result["applied_settings"][name] == {
                        "value": value,
                        "source": "config",
                    }
                else:
                    assert run.result["applied_settings"][name]["source"] == "unsupported"
        return run

    def test_steps(self, tmp_path: Path, fake: FakeServer, max_steps: int = 3) -> GateRun:
        run = self.run(
            tmp_path, fake, self.spec(tmp_path / "trial", "finance-loop", fake, max_steps=max_steps)
        )
        self.check_schemas(run)
        assert run.result["end_state"] == "step_limit", run.explain()
        extra = self.capabilities["settings"]["max_steps"].get("extra_calls_at_limit", 0)
        calls = len(self.agent_requests(run))
        assert max_steps <= calls <= max_steps + extra, (
            f"{calls} calls for max_steps {max_steps} (+{extra})"
        )
        return run

    def test_tools(self, tmp_path: Path, fake: FakeServer) -> GateRun:
        run = self.run(tmp_path, fake, self.spec(tmp_path / "trial", "finance-emi", fake))
        first = self.agent_requests(run)[0]["body"]
        sent = {t["function"]["name"]: t["function"] for t in first.get("tools", [])}
        manifest = json.loads(TOOLS_SNAPSHOT.read_text())
        expected = {self.tool_name(t["name"]): t for t in manifest}
        assert set(sent) == set(expected), (
            f"extra {set(sent) - set(expected)}, missing {set(expected) - set(sent)}"
        )
        wrapper = self.description_wrapper
        for name, tool in expected.items():
            description = sent[name].get("description")
            if wrapper is not None and tool.get("description"):
                assert unwrap_description(description, wrapper) != description, (
                    f"{name}: the declared description wrapper is missing"
                )
            assert unwrap_description(description, wrapper) == tool.get("description"), name
            parameters = unwrap_schema_descriptions(sent[name].get("parameters"), wrapper)
            assert parameters == tool["inputSchema"], name
        return run

    def test_timeout(self, tmp_path: Path, fake: FakeServer, timeout_s: float = 15.0) -> GateRun:
        """The first model call hangs for 60 s. timeout_s must exceed the harness's start-up
        (Hermes takes several seconds to import and connect MCP), so the hung call is in
        flight when the deadline passes: that is what this test is for."""
        run = self.run(
            tmp_path,
            fake,
            self.spec(tmp_path / "trial", "finance-timeout", fake, timeout_s=timeout_s),
        )
        self.check_schemas(run)
        assert run.report["label"] == "agent", run.explain()
        assert run.result["end_state"] == "timeout", run.explain()
        hung = [r for r in self.agent_requests(run) if r.get("fault") == "timeout"]
        assert hung, "the deadline passed before the hung model call was sent"
        assert run.wall_s < timeout_s + 10, run.wall_s
        return run

    def test_malformed_tool_call(self, tmp_path: Path, fake: FakeServer) -> GateRun:
        run = self.run(tmp_path, fake, self.spec(tmp_path / "trial", "finance-malformed", fake))
        self.check_schemas(run)
        assert run.result["end_state"] == "answered", run.explain()
        assert run.result["counts"]["malformed_tool_calls"] >= 1, run.result["counts"]
        second = self.agent_requests(run)[1]["body"]["messages"]
        tool_msgs = [m for m in second if m.get("role") == "tool"]
        assert tool_msgs, "the malformed call's error never went back to the model"
        return run

    def test_no_harness_retries(self, tmp_path: Path, fake: FakeServer) -> GateRun:
        run = self.run(tmp_path, fake, self.spec(tmp_path / "trial", "finance-429", fake))
        self.check_schemas(run)
        assert run.result["end_state"] == "harness_error", run.explain()
        assert run.result["final_answer"] is None
        assert len(self.agent_requests(run)) == 1, (
            f"{len(self.agent_requests(run))} requests: the harness retried"
        )
        return run

    def test_conversation(self, tmp_path: Path, fake: FakeServer) -> GateRun:
        spec = self.spec(tmp_path / "trial", "finance-chat", fake)
        prompt = prompt_text(SIM_PROMPT_FILE)
        opening = "I don't really know where to start. My husband handled all of this."
        spec["task"]["messages"] = [{"role": "user", "content": opening}]
        spec["task"]["client_sim"] = {
            "persona": "Meera, 41, Pune. Widowed in March; the home loan is now in her name.",
            "hidden_facts": ["Monthly take-home Rs 92,000"],
            "concerns": ["Can I keep the house?"],
            "goal": "Know whether she can keep the house",
            "opening_message": opening,
            "max_client_turns": 3,
            "model": {
                "name": "fake/sim-client",
                "base_url": self.base_url(fake),
                "api_key_env": SIM_KEY_ENV,
                "temperature": 0,
                "max_output_tokens": 300,
                "prompt": {
                    "id": "client-sim",
                    "version": "sim-v1",
                    "sha256": _sha(prompt),
                    "text": prompt,
                },
            },
        }
        run = self.run(tmp_path, fake, spec)
        self.check_schemas(run)
        conv = run.result["conversation"]
        assert run.result["end_state"] == "answered", run.explain()
        assert conv["ended_by"] == "client", conv
        assert conv["agent_turns"] == 3 and conv["client_turns"] == 3, conv
        assert "budget" in (run.result["final_answer"] or "") or "EMIs" in (
            run.result["final_answer"] or ""
        )
        # The harness kept the whole conversation: its last request holds every client message.
        last = self.agent_requests(run)[-1]["body"]["messages"]
        said = [_text(m["content"]) for m in last if m.get("role") == "user"]
        for turn in [t for t in conv["transcript"] if t["source"] in ("task", "client_sim")][:-1]:
            assert any(turn["content"] in s for s in said), (
                f"lost client message: {turn['content']}"
            )
        # The simulator saw only visible text, never tool calls or results.
        sim_reqs = [r for r in run.requests if r["script"] == "sim-client"]
        assert sim_reqs and all(
            m["role"] in ("system", "user", "assistant") and "tool_calls" not in m
            for r in sim_reqs
            for m in r["body"]["messages"]
        )
        return run


def proxy_requests(trial_dir: Path, spans: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The requests LiteLLM logged for the trial, in the fake capture's shape."""
    rows = []
    chats = sorted(
        (s for s in spans if s["name"].startswith("chat ")),
        key=lambda s: int(s["startTimeUnixNano"]),
    )
    for span in chats:
        a = attr_dict(span)
        body = json.loads((trial_dir / "out" / a["evals.request_ref"]).read_text())
        rows.append(
            {
                "body": body,
                "script": str(a.get("gen_ai.request.model", "")).split("/")[-1],
                "fault": None,
                "status": a.get("evals.proxy.status"),
                "role": a.get("evals.role"),
            }
        )
    return rows


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


def proxy_gate(gate: Gate, budget_usd: float = 0.05) -> Gate | None:
    """The same gate routed through LiteLLM, or None unless EVALS_PROXY_URL (for example
    http://127.0.0.1:4000) and LITELLM_MASTER_KEY are set. Only fake/* models are used, so the
    budget is a test of the cap, not real money."""
    import dataclasses

    from evals_adapter.proxy import ProxyClient

    url = os.environ.get("EVALS_PROXY_URL")
    master = os.environ.get("LITELLM_MASTER_KEY")
    if not url or not master:
        return None
    settings = ProxySettings(
        ProxyClient(url, master), budget_usd=budget_usd, sim_budget_usd=budget_usd
    )
    return dataclasses.replace(gate, proxy=settings, proxy_base_url=url.rstrip("/") + "/v1")
