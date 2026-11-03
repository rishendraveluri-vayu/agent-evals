import os
import shutil
import subprocess
import sys
import time
import urllib.request
from collections.abc import Iterator
from pathlib import Path

import pytest
from finance_mcp.server import FinanceServer, create_server
from support import EXAMPLE_CLIENT, HttpServer, free_port


@pytest.fixture
def state_dir(tmp_path: Path) -> Path:
    """A trial state directory holding the synthetic example client."""
    shutil.copy(EXAMPLE_CLIENT, tmp_path / "client.json")
    return tmp_path


@pytest.fixture
def server(state_dir: Path) -> FinanceServer:
    return create_server(state_dir)


@pytest.fixture(scope="session")
def shared_state_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    path = tmp_path_factory.mktemp("trial-state")
    shutil.copy(EXAMPLE_CLIENT, path / "client.json")
    return path


@pytest.fixture(scope="session")
def http_server(shared_state_dir: Path) -> Iterator[HttpServer]:
    """The real CLI entry point, serving streamable HTTP on a free port."""
    port = free_port()
    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "finance_mcp",
            "--transport",
            "http",
            "--port",
            str(port),
            "--state-dir",
            str(shared_state_dir),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    base = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + 15
    while True:
        try:
            with urllib.request.urlopen(f"{base}/health", timeout=1) as response:
                if response.status == 200:
                    break
        except OSError:
            pass
        if proc.poll() is not None or time.monotonic() > deadline:
            proc.kill()
            raise RuntimeError(f"HTTP server did not start: {proc.stderr.read().decode()}")
        time.sleep(0.05)
    yield HttpServer(url=f"{base}/mcp", base=base, state_dir=shared_state_dir)
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
    proc.stderr.close()
