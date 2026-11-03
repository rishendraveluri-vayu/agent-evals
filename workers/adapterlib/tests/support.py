"""Test helpers: a valid contract v2 spec, the contract schemas, and a tiny chat server that
plays the simulated client."""

from __future__ import annotations

import copy
import hashlib
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import jsonschema

REPO = Path(__file__).resolve().parents[3]
CONTRACT = REPO / "contract" / "v2"
FIXTURES = Path(__file__).resolve().parent / "fixtures"
SCRIPTED_CMD = [sys.executable, str(FIXTURES / "scripted_adapter.py")]

SIM_PROMPT = (
    "You are {{persona}}. Facts:\n{{hidden_facts}}\nConcerns:\n{{concerns}}\n"
    "Goal: {{goal}}\nEnd with {{end_marker}}."
)


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def schema(name: str) -> dict[str, Any]:
    return json.loads((CONTRACT / f"{name}.schema.json").read_text())


def validator(name: str) -> jsonschema.Draft202012Validator:
    return jsonschema.Draft202012Validator(schema(name), format_checker=jsonschema.FormatChecker())


def errors(name: str, doc: Any) -> list[str]:
    return [f"{list(e.absolute_path)}: {e.message}" for e in validator(name).iter_errors(doc)]


BASE_SPEC: dict[str, Any] = {
    "contract_version": "2",
    "trial": {
        "id": "t_test_0001",
        "experiment_id": None,
        "config_id": "c_test",
        "config_hash": "sha256:" + "a" * 64,
        "task_id": "emi-basic-01",
        "task_version": "sha256:" + "b" * 64,
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
        "id": "finance-advisor",
        "version": "v1",
        "sha256": sha("Be kind."),
        "text": "Be kind.",
    },
    "model": {
        "name": "fake/finance-emi",
        "base_url": "http://127.0.0.1:9/v1",
        "api_key_env": "EVALS_MODEL_API_KEY",
        "api_format": "openai_chat",
    },
    "settings": {
        "temperature": 0.2,
        "max_output_tokens": 1024,
        "max_steps": 15,
        "timeout_s": 20,
        "parallel_tool_calls": None,
        "memory": None,
        "skills": None,
        "compression": None,
    },
    "settings_sources": {
        "temperature": "config",
        "max_output_tokens": "platform_default",
        "max_steps": "platform_default",
        "timeout_s": "platform_default",
        "parallel_tool_calls": "unsupported",
        "memory": "unsupported",
        "skills": "unsupported",
        "compression": "unsupported",
    },
    "harness_options": {
        "turns": [
            {
                "reply": "Your EMI is Rs 8,997.26.",
                "model_calls": 2,
                "tools": [
                    {
                        "name": "calculate_emi",
                        "args": {"principal": 1000000},
                        "result": '{"emi": "8997.26"}',
                    }
                ],
            }
        ]
    },
    "tools": {
        "toolset": {"id": "finance", "version": "v1", "sha256": "c" * 64},
        "mcp_servers": [
            {
                "name": "finance",
                "command": ["/opt/finance-mcp/bin/finance-mcp", "--transport", "stdio"],
                "allowed_tools": ["calculate_emi"],
                "tool_timeout_s": 30,
            }
        ],
        "enabled_builtins": [],
    },
    "seed": {"memory": [], "skills": []},
}


def make_spec(**changes: Any) -> dict[str, Any]:
    """BASE_SPEC with dotted-path changes: make_spec(**{"settings.timeout_s": 1})."""
    spec = copy.deepcopy(BASE_SPEC)
    for path, value in changes.items():
        node = spec
        parts = path.split(".")
        for part in parts[:-1]:
            node = node[part]
        node[parts[-1]] = value
    return spec


def client_sim(base_url: str, max_turns: int = 3) -> dict[str, Any]:
    return {
        "persona": "Meera, 41, Pune",
        "hidden_facts": ["Take-home Rs 92,000 a month"],
        "concerns": ["Can I keep the house?"],
        "goal": "Know whether she can keep the house",
        "opening_message": "I don't know where to start.",
        "max_client_turns": max_turns,
        "model": {
            "name": "fake/sim",
            "base_url": base_url,
            "api_key_env": "EVALS_SIM_API_KEY",
            "temperature": 0,
            "max_output_tokens": 300,
            "prompt": {
                "id": "client-sim",
                "version": "sim-v1",
                "sha256": sha(SIM_PROMPT),
                "text": SIM_PROMPT,
            },
        },
    }


class SimServer:
    """Answers chat completions with scripted client replies, by how many client messages
    (assistant role, from the client's side) are already in the request."""

    def __init__(self, replies: list[str]) -> None:
        self.replies = replies
        self.requests: list[dict[str, Any]] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.requests.append({"body": body, "auth": self.headers.get("Authorization")})
                n = sum(1 for m in body["messages"] if m["role"] == "assistant") - 1
                text = outer.replies[min(n, len(outer.replies) - 1)]
                payload = json.dumps(
                    {
                        "choices": [{"message": {"role": "assistant", "content": text}}],
                        "usage": {"prompt_tokens": 1, "completion_tokens": 1},
                    }
                ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args: Any) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/v1"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def attrs(span: dict[str, Any]) -> dict[str, Any]:
    from evals_adapter.trace import attr_dict

    return attr_dict(span)
