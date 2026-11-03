"""The server with an mcp 1.30.0 client, the version langchain-mcp-adapters 0.3.2 resolves (it
pins mcp<2). The client runs in its own locked environment (tests/compat/mcp1/uv.lock), because
mcp 1.x and 2.x cannot share one. uv builds that environment on first use.
"""

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
from finance_mcp.server import create_server
from support import SAMPLE_CALLS, SNAPSHOT, call, stdio_command, text_of

COMPAT = Path(__file__).resolve().parent / "compat" / "mcp1"
ERROR_CALL = ["calculate_emi", {"principal": -1, "annual_rate_pct": 9, "tenure_months": 12}]


def run_mcp1_client(config: dict[str, Any]) -> dict[str, Any]:
    uv = shutil.which("uv")
    if uv is None:
        pytest.skip("uv is not on PATH, so the mcp 1.30.0 client environment cannot be built")
    env = {
        k: v for k, v in os.environ.items() if k not in ("VIRTUAL_ENV", "UV_PROJECT_ENVIRONMENT")
    }
    proc = subprocess.run(
        [
            uv,
            "run",
            "--project",
            str(COMPAT),
            "--locked",
            "--quiet",
            "python",
            str(COMPAT / "client.py"),
        ],
        input=json.dumps(config),
        capture_output=True,
        text=True,
        timeout=180,
        env=env,
    )
    assert proc.returncode == 0, proc.stderr[-3000:]
    return json.loads(proc.stdout)


def expected_texts(state_dir: Path) -> list[str]:
    server = create_server(state_dir)
    return [text_of(call(server, name, arguments)) for name, arguments in SAMPLE_CALLS]


def check(output: dict[str, Any], state_dir: Path) -> None:
    assert output["mcp_version"] == "1.30.0"
    assert output["protocol_version"] == "2025-11-25"
    assert output["server_name"] == "finance-mcp"
    # The manifest the 1.x client sees is the snapshot, key order included.
    assert output["tools"] == json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    assert json.dumps(output["tools"], ensure_ascii=False) == json.dumps(
        json.loads(SNAPSHOT.read_text(encoding="utf-8")), ensure_ascii=False
    )
    *good, bad = output["results"]
    assert [r["is_error"] for r in good] == [False] * len(SAMPLE_CALLS)
    assert all(r["structured"] is None for r in output["results"])
    assert [r["content"] for r in good] == [
        [{"type": "text", "text": t}] for t in expected_texts(state_dir)
    ]
    assert bad["is_error"] is True
    assert bad["content"][0]["text"].startswith(
        "Error executing tool calculate_emi: invalid arguments: principal: Input should be greater"
    )


def test_mcp1_client_over_stdio(shared_state_dir: Path) -> None:
    command, args = stdio_command(shared_state_dir)
    output = run_mcp1_client(
        {
            "transport": "stdio",
            "command": command,
            "args": args,
            "calls": [*([n, a] for n, a in SAMPLE_CALLS), ERROR_CALL],
        }
    )
    check(output, shared_state_dir)


def test_mcp1_client_over_http(http_server) -> None:
    output = run_mcp1_client(
        {
            "transport": "http",
            "url": http_server.url,
            "calls": [*([n, a] for n, a in SAMPLE_CALLS), ERROR_CALL],
        }
    )
    check(output, http_server.state_dir)
