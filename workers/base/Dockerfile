# Base image for harness workers (D3). Harness images in SP1 build on the same
# runtime settings: read-only root, one writable trial folder at /trial,
# non-root user, and a network that reaches only the API and LiteLLM.
FROM python:3.14-slim@sha256:930e1abba7c4e8f96ed93e8012c35d174d7732752731bbd5e8e757d7ec6f3966

RUN useradd --uid 10001 --no-create-home --home-dir /trial/home trial

COPY netcheck.py /opt/worker/netcheck.py

ENV HOME=/trial/home \
    TMPDIR=/trial/tmp \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

USER 10001
WORKDIR /trial
CMD ["python", "/opt/worker/netcheck.py"]
