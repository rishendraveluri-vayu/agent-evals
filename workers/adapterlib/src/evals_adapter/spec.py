"""The trial folder and spec.json (contract v2, sections 2 and 3)."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

CONTRACT_VERSION = "2"
TRIAL_DIR_ENV = "EVALS_TRIAL_DIR"
DEFAULT_TRIAL_DIR = "/trial"

SETTING_NAMES = (
    "temperature",
    "max_output_tokens",
    "max_steps",
    "timeout_s",
    "parallel_tool_calls",
    "memory",
    "skills",
    "compression",
)

END_STATES = ("answered", "step_limit", "token_limit", "timeout", "agent_error", "harness_error")


class SpecError(ValueError):
    """The spec is not a contract v2 spec. The adapter cannot run the trial."""


@dataclass(frozen=True)
class TrialPaths:
    root: Path

    @classmethod
    def from_env(cls) -> TrialPaths:
        return cls(Path(os.environ.get(TRIAL_DIR_ENV, DEFAULT_TRIAL_DIR)))

    @property
    def spec(self) -> Path:
        return self.root / "spec.json"

    @property
    def state(self) -> Path:
        return self.root / "state"

    @property
    def harness(self) -> Path:
        return self.root / "harness"

    @property
    def home(self) -> Path:
        return self.root / "home"

    @property
    def tmp(self) -> Path:
        return self.root / "tmp"

    @property
    def out(self) -> Path:
        return self.root / "out"

    @property
    def trace(self) -> Path:
        return self.out / "trace.jsonl"

    @property
    def result(self) -> Path:
        return self.out / "result.json"

    @property
    def artifacts(self) -> Path:
        return self.out / "artifacts"

    @property
    def sim_cache(self) -> Path:
        """Client replies the runner already has for this task and simulator (D22). Read-only."""
        return self.root / "sim_cache.json"

    @property
    def sim_replies(self) -> Path:
        """New client replies this trial generated, for the runner to store."""
        return self.out / "sim_replies.jsonl"

    @property
    def stdout_log(self) -> Path:
        return self.out / "stdout.log"

    @property
    def stderr_log(self) -> Path:
        return self.out / "stderr.log"

    @property
    def runner_report(self) -> Path:
        return self.out / "runner-report.json"


_REQUIRED = {
    "trial": ("id", "task_id"),
    "task": ("messages", "client_sim"),
    "system_prompt": ("text",),
    "model": ("name", "base_url", "api_key_env", "api_format"),
    "settings": SETTING_NAMES,
    "settings_sources": SETTING_NAMES,
    "tools": ("toolset", "mcp_servers", "enabled_builtins"),
    "seed": ("memory", "skills"),
}


def check_spec(spec: Any) -> dict[str, Any]:
    """Structural check with the standard library only. The JSON Schema in contract/v2 is the
    full definition; the runner and the tests validate against it."""
    if not isinstance(spec, dict):
        raise SpecError("spec is not a JSON object")
    if spec.get("contract_version") != CONTRACT_VERSION:
        raise SpecError(
            f"contract_version is {spec.get('contract_version')!r}, "
            f"adapter speaks {CONTRACT_VERSION!r}"
        )
    for section, keys in _REQUIRED.items():
        block = spec.get(section)
        if not isinstance(block, dict):
            raise SpecError(f"spec.{section} is missing or not an object")
        for key in keys:
            if key not in block:
                raise SpecError(f"spec.{section}.{key} is missing")
    messages = spec["task"]["messages"]
    if not isinstance(messages, list) or not messages or messages[-1].get("role") != "user":
        raise SpecError("spec.task.messages must be a non-empty list ending with a user message")
    if (
        not isinstance(spec["settings"]["timeout_s"], (int, float))
        or spec["settings"]["timeout_s"] <= 0
    ):
        raise SpecError("spec.settings.timeout_s must be a positive number")
    return spec


def load_spec(path: Path) -> dict[str, Any]:
    try:
        spec = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SpecError(f"no spec at {path}") from exc
    except json.JSONDecodeError as exc:
        raise SpecError(f"spec is not valid JSON: {exc}") from exc
    return check_spec(spec)


@dataclass(frozen=True)
class McpServer:
    name: str
    command: str
    args: list[str]
    allowed_tools: list[str]
    tool_timeout_s: float


def mcp_servers(spec: dict[str, Any]) -> list[McpServer]:
    servers = []
    for entry in spec["tools"]["mcp_servers"]:
        cmd = list(entry["command"])
        servers.append(
            McpServer(
                name=entry["name"],
                command=cmd[0],
                args=cmd[1:],
                allowed_tools=list(entry["allowed_tools"]),
                tool_timeout_s=float(entry["tool_timeout_s"]),
            )
        )
    return servers
