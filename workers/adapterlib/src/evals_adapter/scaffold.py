# ruff: noqa: E501 - the templates below are files, and their lines are as long as they need to be
"""Create a new harness worker folder (contract v2 section 4, R2, R11).

    evals-new-harness langgraph            # or: make new-harness NAME=langgraph

writes workers/<name>/ with an adapter stub on the shared library, a capabilities template, the
gate tests, a probe script, a Dockerfile and a README, and prints the docker-compose service to add. The author then writes `setup` and `run_turn`, sets
IMPLEMENTED = True, runs the probe to fill capabilities.json from evidence, and makes the gate
tests pass. Nothing else in the platform changes.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from evals_adapter.spec import SETTING_NAMES

WORKERS = Path(__file__).resolve().parents[3]

PYPROJECT = """[project]
name = "{name}-worker"
version = "0.1.0"
description = "The {name} harness adapter on the shared adapter library (contract v2)."
readme = "README.md"
requires-python = ">={python}"
dependencies = [
    "evals-adapter",
    # TODO: the harness package, pinned to an exact version, and an MCP client if it needs one.
]

[project.scripts]
{name}-adapter = "{pkg}.adapter:entry"

[tool.uv.sources]
evals-adapter = {{ path = "../adapterlib", editable = true }}

[build-system]
requires = ["uv_build>=0.13.6,<0.14"]
build-backend = "uv_build"

[tool.uv.build-backend]
module-name = "{pkg}"

[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "-q"

[dependency-groups]
dev = [
    "jsonschema>=4.25.1",
    "pytest>=9.2.0",
    "ruff>=0.17.3",
]
"""

ADAPTER = '''"""The {name} harness on the shared adapter library (contract v2, docs/adapter-contract.md).

Write two methods. The library does the rest: the spec, the whole-trial timeout, the spans, the
conversation loop with the simulated client, end states and the result.

Rules that matter here (R10): models only through ctx.base_url with ctx.model_api_key; no
retries in the harness (LiteLLM retries); only the task's tools (ctx.mcp_servers); nothing
learns unless the config says so; report, never judge.
"""

from __future__ import annotations

from pathlib import Path

from evals_adapter import Adapter, TrialContext, TurnResult, main

# Set to True once setup and run_turn work; the gate tests skip until then.
IMPLEMENTED = False


class {cls}(Adapter):
    name = "{name}"
    capabilities_path = Path(__file__).with_name("capabilities.json")

    def version(self) -> str:
        return "TODO: the harness package version"

    def setup(self, ctx: TrialContext) -> None:
        """Map ctx.settings onto the harness (apply_settings) and start its MCP client.

        - ctx.settings: temperature, max_output_tokens, max_steps, timeout_s, parallel_tool_calls,
          memory, skills, compression (None where capabilities.json says unsupported).
        - ctx.mcp_servers: name, command, args, allowed_tools, tool_timeout_s. Start them with
          ctx.child_env(), which leaves the model key out.
        - ctx.applied.set(name, value, "harness_default", observed=...) for anything the harness
          decides on its own, so the UI shows it.
        - ctx.integrity_paths: files the harness can edit with no switch to stop it.
        """
        raise NotImplementedError

    def run_turn(
        self, ctx: TrialContext, history: list[dict[str, str]], max_steps: int | None
    ) -> TurnResult:
        """Run one agent turn on history[-1] (the new user message) using the harness's own
        session for earlier turns, within max_steps model calls.

        Report each tool call with ctx.tool_started(call_id, name, args) and
        ctx.tool_finished(call_id, result, is_error=..., error_kind=...), and D18 cases with
        ctx.error_event("malformed_tool_call" | "unknown_tool", message).
        Return TurnResult(stop="answered" | "step_limit" | "token_limit" | "agent_error" |
        "harness_error", reply=..., model_calls=..., input_tokens=..., output_tokens=...).
        """
        raise NotImplementedError


def entry() -> None:
    main({cls}())


if __name__ == "__main__":
    entry()
'''

TEST_GATE = '''"""The {name} gate tests (contract v2 section 8), against the fake model server.

They skip until IMPLEMENTED is True in src/{pkg}/adapter.py. Needs `uv sync` once in
services/fake-llm and services/finance-mcp.
"""

import json
import sys
from pathlib import Path

import pytest
from evals_adapter.gate import FakeServer, Gate

from {pkg}.adapter import IMPLEMENTED

CAPS_FILE = Path(__file__).resolve().parents[1] / "src" / "{pkg}" / "capabilities.json"
CAPS = json.loads(CAPS_FILE.read_text())
GATE = Gate(
    harness="{name}",
    adapter_cmd=[sys.executable, "-m", "{pkg}.adapter"],
    capabilities=CAPS,
    # If the harness renames MCP tools, say how, e.g. lambda n: f"mcp__finance__{{n}}".
    tool_name=lambda name: name,
)

pytestmark = pytest.mark.skipif(not IMPLEMENTED, reason="adapter not implemented yet")


@pytest.fixture(scope="module")
def fake():
    server = FakeServer()
    yield server
    server.stop()


def test_answer(tmp_path, fake):
    GATE.test_answer(tmp_path, fake)


def test_settings(tmp_path, fake):
    GATE.test_settings(tmp_path, fake)


def test_unset_not_sent(tmp_path, fake):
    GATE.test_unset_not_sent(tmp_path, fake)


def test_steps(tmp_path, fake):
    GATE.test_steps(tmp_path, fake)


def test_tools(tmp_path, fake):
    GATE.test_tools(tmp_path, fake)


def test_timeout(tmp_path, fake):
    GATE.test_timeout(tmp_path, fake)


def test_malformed_tool_call(tmp_path, fake):
    GATE.test_malformed_tool_call(tmp_path, fake)


def test_no_harness_retries(tmp_path, fake):
    GATE.test_no_harness_retries(tmp_path, fake)


def test_conversation(tmp_path, fake):
    GATE.test_conversation(tmp_path, fake)
'''

TEST_CAPS = '''"""capabilities.json must match what a fresh probe sees (R11: generated from evidence)."""

import pytest
from evals_adapter.probe import probe
from test_gate import CAPS_FILE, GATE

from {pkg}.adapter import IMPLEMENTED

pytestmark = pytest.mark.skipif(not IMPLEMENTED, reason="adapter not implemented yet")

PROBED = ("temperature", "max_output_tokens", "max_steps", "parallel_tool_calls")
FIELDS = ("supported", "default", "extra_calls_at_limit", "observed")


def test_capabilities_match_a_fresh_probe():
    fresh = probe(CAPS_FILE, GATE.adapter_cmd, GATE.env, GATE.tool_name(""))
    for name in PROBED:
        for field in FIELDS:
            assert fresh["settings"][name].get(field) == GATE.capabilities["settings"][name].get(
                field
            ), f"{{name}}.{{field}} changed: run ./probe.sh and review the diff"
'''

PROBE_SH = """#!/usr/bin/env bash
# Fill capabilities.json from evidence against the fake model server, then review the diff.
set -euo pipefail
cd "$(dirname "$0")"
uv run evals-probe-harness --capabilities src/{pkg}/capabilities.json -- "$PWD/.venv/bin/python" -m {pkg}.adapter
"""

README = """# {name} worker

The {name} harness adapter on the shared adapter library (`workers/adapterlib`). Created by
`evals-new-harness`.

1. Add the harness package (exact version) to `pyproject.toml`, then `uv sync`.
2. Write `setup` and `run_turn` in `src/{pkg}/adapter.py`, and set `IMPLEMENTED = True`.
3. `./probe.sh` writes the probed fields of `src/{pkg}/capabilities.json` from what reaches the
   fake model. Declare memory, skills and compression by hand, and list `known_differences`.
   Set `version.package` and `version.ref` there to the harness package and its exact version:
   while either is still `TODO` the platform leaves the harness out of its catalogue and refuses
   configs for it.
4. `uv run pytest -q` runs the gate tests and the capabilities drift test.
5. Add the `worker-{name}` service that `evals-new-harness` printed to `docker-compose.yml`, then
   `docker compose up -d --build worker-{name}`. The `Dockerfile` here builds it from `uv.lock`.
6. Effect checks on real models (D24) need a sign-off with a cost estimate first (R8).
"""


DOCKERFILE = r"""# {name} worker (SP3, D3): one long-lived container per harness, one trial at a time in
# /trial. The entrypoint is the worker loop, evals-worker. Build from the repo root:
#   docker build -f workers/{name}/Dockerfile -t agent-evals/worker-{name}:dev .
# The runtime stage is workers/base again (same pinned Python, uid 10001, HOME and TMPDIR inside
# /trial, netcheck), repeated here because compose cannot order a FROM on another service's image.
# Written by evals-new-harness from workers/ownloop/Dockerfile: every worker uses this pinned
# Python 3.14 image, so change both FROM python lines if the harness needs another version.
FROM ghcr.io/astral-sh/uv:0.13.6@sha256:af22a52f5eafef3d78e551599d405c02df61919d18028f0cea8eda93bc9986d0 AS uv

FROM python:3.14-slim@sha256:930e1abba7c4e8f96ed93e8012c35d174d7732752731bbd5e8e757d7ec6f3966 AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_NO_CACHE=1

# The finance MCP server from its own lockfile. Every spec starts it as
# /opt/finance-mcp/bin/finance-mcp over stdio, inside the trial's process group (D14).
WORKDIR /src/services/finance-mcp
COPY services/finance-mcp/pyproject.toml services/finance-mcp/uv.lock services/finance-mcp/.python-version ./
RUN UV_PROJECT_ENVIRONMENT=/opt/finance-mcp uv sync --locked --no-dev --no-install-project
COPY services/finance-mcp/README.md ./
COPY services/finance-mcp/src ./src
RUN UV_PROJECT_ENVIRONMENT=/opt/finance-mcp uv sync --locked --no-dev --no-editable

# The harness from its own lockfile, with the adapter library (and evals-worker) from source.
# Third-party packages first, so a source edit does not reinstall them.
COPY workers/adapterlib/pyproject.toml workers/adapterlib/README.md /src/workers/adapterlib/
WORKDIR /src/workers/{name}
COPY workers/{name}/pyproject.toml workers/{name}/uv.lock workers/{name}/.python-version ./
RUN UV_PROJECT_ENVIRONMENT=/opt/harness uv sync --locked --no-dev --no-install-project --no-install-local
COPY workers/adapterlib/src /src/workers/adapterlib/src
COPY workers/{name}/README.md ./
COPY workers/{name}/src ./src
RUN UV_PROJECT_ENVIRONMENT=/opt/harness uv sync --locked --no-dev --no-editable

FROM python:3.14-slim@sha256:930e1abba7c4e8f96ed93e8012c35d174d7732752731bbd5e8e757d7ec6f3966
RUN useradd --uid 10001 --no-create-home --home-dir /trial/home trial \
    && mkdir -p /trial \
    && chown 10001:10001 /trial
COPY workers/base/netcheck.py /opt/worker/netcheck.py
COPY --from=build /opt/finance-mcp /opt/finance-mcp
COPY --from=build /opt/harness /opt/harness
# EVALS_WORKER_ISOLATION=container: between trials the worker kills every other process in the
# container and wipes /dev/shm as well as /trial (D3).
ENV HOME=/trial/home \
    TMPDIR=/trial/tmp \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/harness/bin:$PATH \
    EVALS_HARNESS={name} \
    EVALS_ADAPTER_CMD="/opt/harness/bin/python -m {pkg}.adapter" \
    EVALS_WORKER_ISOLATION=container
USER 10001
WORKDIR /trial
ENTRYPOINT ["/opt/harness/bin/evals-worker"]
"""

COMPOSE_SERVICE = """  worker-{name}:
    <<: *harness-worker
    build:
      context: .
      dockerfile: workers/{name}/Dockerfile
    image: agent-evals/worker-{name}:${{EVALS_IMAGE_TAG:-dev}}
"""


def capabilities(name: str) -> dict:
    settings = {}
    for setting in SETTING_NAMES:
        if setting == "timeout_s":
            settings[setting] = {
                "supported": True,
                "native": "wrapper",
                "evidence": "declared:the adapter library's watchdog",
            }
        else:
            settings[setting] = {"supported": False, "evidence": "none"}
    return {
        "contract_version": "2",
        "harness": name,
        "version": {"package": "TODO", "ref": "TODO"},
        "model_api_formats": ["openai_chat"],
        "settings": settings,
        "harness_options_schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {},
        },
        "known_differences": [],
    }


def scaffold(name: str, workers: Path = WORKERS, python: str = "3.14") -> Path:
    if not re.fullmatch(r"[a-z][a-z0-9-]*", name):
        raise ValueError(
            "name must be lower case letters, digits and dashes, starting with a letter"
        )
    root = workers / name
    if root.exists():
        raise FileExistsError(f"{root} already exists")
    pkg = name.replace("-", "_") + "_adapter"
    cls = "".join(part.capitalize() for part in name.split("-")) + "Adapter"
    values = {"name": name, "pkg": pkg, "cls": cls, "python": python}
    files = {
        "pyproject.toml": PYPROJECT,
        "README.md": README,
        ".python-version": f"{python}\n",
        f"src/{pkg}/__init__.py": f'"""The {name} harness adapter (contract v2)."""\n',
        f"src/{pkg}/adapter.py": ADAPTER,
        "tests/test_gate.py": TEST_GATE,
        "tests/test_capabilities.py": TEST_CAPS,
        "probe.sh": PROBE_SH,
        "Dockerfile": DOCKERFILE,
    }
    for rel, template in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(template.format(**values) if "{" in template else template)
    (root / f"src/{pkg}/capabilities.json").write_text(
        json.dumps(capabilities(name), indent=2) + "\n"
    )
    (root / "probe.sh").chmod(0o755)
    return root


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Create workers/<name>/ for a new harness.")
    parser.add_argument("name")
    parser.add_argument(
        "--python", default="3.14", help="the harness's Python version (the worker image has 3.14)"
    )
    parser.add_argument("--workers-dir", type=Path, default=WORKERS)
    args = parser.parse_args(argv)
    root = scaffold(args.name, args.workers_dir, args.python)
    print(f"created {root}. Next: see {root / 'README.md'}")
    print("Then add its worker to docker-compose.yml, beside worker-ownloop:\n")
    print(COMPOSE_SERVICE.format(name=args.name))
    sys.exit(0)


if __name__ == "__main__":
    main()
