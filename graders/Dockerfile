# Grader worker (SP4, R14): grading is its own step after the trial. The entrypoint is the grading
# loop, evals-grader: claim a trial that needs grading from the API, download its files over HTTP,
# run the task's graders, report. It mounts nothing (D2). Build from this folder:
#   docker build -t agent-evals/grader:dev graders
FROM ghcr.io/astral-sh/uv:0.13.6@sha256:af22a52f5eafef3d78e551599d405c02df61919d18028f0cea8eda93bc9986d0 AS uv

FROM python:3.14-slim@sha256:930e1abba7c4e8f96ed93e8012c35d174d7732752731bbd5e8e757d7ec6f3966 AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_NO_CACHE=1
WORKDIR /src/graders
# Third-party packages first, so a grader fix does not reinstall them.
COPY pyproject.toml uv.lock .python-version ./
RUN UV_PROJECT_ENVIRONMENT=/opt/graders uv sync --locked --no-dev --no-install-project
COPY src ./src
RUN UV_PROJECT_ENVIRONMENT=/opt/graders uv sync --locked --no-dev --no-editable

FROM python:3.14-slim@sha256:930e1abba7c4e8f96ed93e8012c35d174d7732752731bbd5e8e757d7ec6f3966
RUN useradd --uid 10001 --no-create-home --home-dir /trial/home grader \
    && mkdir -p /trial \
    && chown 10001:10001 /trial
COPY --from=build /opt/graders /opt/graders
# /trial is the one writable folder (a tmpfs in compose): downloaded trial files and each
# unit_test's empty working folder live under TMPDIR and are deleted after each job.
ENV HOME=/trial/home \
    TMPDIR=/trial/tmp \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/graders/bin:$PATH
USER 10001
WORKDIR /trial
ENTRYPOINT ["/opt/graders/bin/evals-grader"]
