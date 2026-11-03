import socket
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest
import uvicorn
from fake_llm import create_app
from starlette.applications import Starlette
from starlette.testclient import TestClient

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"


@pytest.fixture
def client() -> Iterator[TestClient]:
    """A fresh app (fresh registry, counters and capture) per test, served in-process."""
    with TestClient(create_app(SCRIPTS_DIR)) as test_client:
        yield test_client


@dataclass
class LiveServer:
    url: str
    app: Starlette

    def reset(self) -> None:
        self.app.state.fake.requests.clear()
        self.app.state.fake.faults.reset()


@pytest.fixture(scope="session")
def live_server_session() -> Iterator[LiveServer]:
    """A real uvicorn server on a free port, for behaviour TestClient cannot show:
    client timeouts, dropped connections, real concurrency, the official openai client."""
    app = create_app(SCRIPTS_DIR)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", timeout_graceful_shutdown=1))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    thread.start()
    deadline = time.monotonic() + 5
    while not server.started:
        if time.monotonic() > deadline:
            raise RuntimeError("uvicorn did not start")
        time.sleep(0.01)
    yield LiveServer(url=f"http://127.0.0.1:{port}", app=app)
    server.should_exit = True
    thread.join(timeout=5)
    sock.close()


@pytest.fixture
def live(live_server_session: LiveServer) -> LiveServer:
    live_server_session.reset()
    return live_server_session
