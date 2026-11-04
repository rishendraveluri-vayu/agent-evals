# Hermes worker (SP3, D3): one long-lived container per harness, one trial at a time in
# /trial. The entrypoint is the worker loop, evals-worker. Build from the repo root:
#   docker build -f workers/hermes/Dockerfile -t agent-evals/worker-hermes:dev .
# The runtime stage is workers/base again (same pinned Python, uid 10001, HOME and TMPDIR inside
# /trial, netcheck), repeated here because compose cannot order a FROM on another service's image.
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

# Hermes at the pinned SHA, installed from its own lockfile by the script the tests use
# (scripts/setup_hermes.sh). Its source is never modified (CLAUDE.md).
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/setup_hermes.sh /src/scripts/setup_hermes.sh
RUN /src/scripts/setup_hermes.sh /opt/hermes-agent \
    && test "$(git -C /opt/hermes-agent rev-parse HEAD)" = 6112c2adb9e11f69734a29be9d2696f345ffa06a

# The adapter runs on Hermes's environment with the adapter's and the library's sources on
# PYTHONPATH, as in the gate tests; nothing is installed into Hermes's environment. The worker
# loop gets a small venv of its own (the library is standard library only, so it has no lock).
COPY workers/adapterlib /src/workers/adapterlib
RUN uv venv /opt/harness --python /usr/local/bin/python3.14 \
    && uv pip install --python /opt/harness/bin/python --no-deps /src/workers/adapterlib

FROM python:3.14-slim@sha256:930e1abba7c4e8f96ed93e8012c35d174d7732752731bbd5e8e757d7ec6f3966
RUN useradd --uid 10001 --no-create-home --home-dir /trial/home trial \
    && mkdir -p /trial \
    && chown 10001:10001 /trial
COPY workers/base/netcheck.py /opt/worker/netcheck.py
COPY --from=build /opt/finance-mcp /opt/finance-mcp
COPY --from=build /opt/hermes-agent /opt/hermes-agent
COPY --from=build /opt/harness /opt/harness
COPY workers/adapterlib/src /opt/adapterlib/src
COPY workers/hermes/src /opt/hermes-adapter/src
# The root is read-only at run time, so compile now rather than on every trial.
RUN python -m compileall -q -j 0 --invalidation-mode unchecked-hash -x '/\.venv/' \
    /opt/hermes-agent /opt/adapterlib/src /opt/hermes-adapter/src
# EVALS_WORKER_ISOLATION=container: between trials the worker kills every other process in the
# container and wipes /dev/shm as well as /trial (D3).
ENV HOME=/trial/home \
    TMPDIR=/trial/tmp \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/harness/bin:$PATH \
    EVALS_HARNESS=hermes \
    EVALS_ADAPTER_CMD="env PYTHONPATH=/opt/hermes-adapter/src:/opt/adapterlib/src /opt/hermes-agent/.venv/bin/python -m hermes_adapter.adapter" \
    EVALS_WORKER_ISOLATION=container
USER 10001
WORKDIR /trial
ENTRYPOINT ["/opt/harness/bin/evals-worker"]
