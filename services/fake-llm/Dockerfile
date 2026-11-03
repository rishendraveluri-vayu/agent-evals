# Fake OpenAI-compatible LLM server for tests and CI. Build from this folder:
#   docker build -t agent-evals/fake-llm:dev .
FROM ghcr.io/astral-sh/uv:0.13.6 AS uv

FROM python:3.14-slim@sha256:930e1abba7c4e8f96ed93e8012c35d174d7732752731bbd5e8e757d7ec6f3966 AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app
# Dependencies first, from the lockfile only, so source edits do not reinstall them.
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --locked --no-dev --no-install-project
COPY README.md ./
COPY src ./src
RUN uv sync --locked --no-dev --no-editable

FROM python:3.14-slim@sha256:930e1abba7c4e8f96ed93e8012c35d174d7732752731bbd5e8e757d7ec6f3966
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin fake
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY scripts ./scripts
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    FAKE_LLM_PORT=8080 \
    FAKE_LLM_SCRIPTS_DIR=/app/scripts
USER 10001
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('FAKE_LLM_PORT', '8080') + '/health', timeout=2)"]
CMD ["fake-llm"]
