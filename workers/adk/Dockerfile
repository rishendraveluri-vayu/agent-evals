# Google ADK worker (SP3, D3): one long-lived container per harness, one trial at a time in
# /trial. The entrypoint is the worker loop, evals-worker. Build from the repo root:
#   docker build -f workers/adk/Dockerfile -t agent-evals/worker-adk:dev .
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

# The harness from its own lockfile, with the adapter library (and evals-worker) from source.
# Third-party packages first, so a source edit does not reinstall them.
COPY workers/adapterlib/pyproject.toml workers/adapterlib/README.md /src/workers/adapterlib/
WORKDIR /src/workers/adk
COPY workers/adk/pyproject.toml workers/adk/uv.lock workers/adk/.python-version ./
RUN UV_PROJECT_ENVIRONMENT=/opt/harness uv sync --locked --no-dev --no-install-project --no-install-local
COPY workers/adapterlib/src /src/workers/adapterlib/src
COPY workers/adk/README.md ./
COPY workers/adk/src ./src
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
    EVALS_HARNESS=adk \
    EVALS_ADAPTER_CMD="/opt/harness/bin/python -m adk_adapter.adapter" \
    EVALS_WORKER_ISOLATION=container
USER 10001
WORKDIR /trial
ENTRYPOINT ["/opt/harness/bin/evals-worker"]
