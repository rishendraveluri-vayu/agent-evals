"""Compose smoke test: the running stack answers end to end, with no LLM spend.

Assumes `docker compose up -d --wait` has run. Standard library only.
Run: python3 scripts/smoke.py

Ports follow the same variables as docker-compose.yml (UI_PORT, API_PORT, LITELLM_PORT), so
a stack started on other ports is checked where it runs; SMOKE_UI_URL, SMOKE_API_URL and
SMOKE_LITELLM_URL override them. The one `docker compose exec` goes to the compose project in
COMPOSE_PROJECT_NAME (the compose file's own name, agent-evals, when unset): set it when the
stack was started with `-p <name>`, so the check never reaches into another copy of the stack.

Checks:
- the UI serves its page, and proxies /api/health to the API with the database up;
- the API can write the folders it stores things in (runs/, labels/, configs/prompts/), which are
  mounted from the repo: if not, it says which and how to fix it;
- LiteLLM routes a fake model to the fake server, both plain and streamed;
- the request that reached the fake server carried the temperature we sent.
"""

import json
import os
import sys
import urllib.error
import urllib.request

def _port(name: str, default: str) -> str:
    return os.environ.get(name) or default


UI = os.environ.get("SMOKE_UI_URL", f"http://127.0.0.1:{_port('UI_PORT', '8080')}")
API = os.environ.get("SMOKE_API_URL", f"http://127.0.0.1:{_port('API_PORT', '3000')}")
LITELLM = os.environ.get("SMOKE_LITELLM_URL", f"http://127.0.0.1:{_port('LITELLM_PORT', '4000')}")
PROJECT = os.environ.get("COMPOSE_PROJECT_NAME") or "agent-evals"
KEY = os.environ.get("LITELLM_MASTER_KEY", "sk-local-dev-only")


def get(url: str) -> tuple[int, bytes]:
    """The status and body, for an error status too (the API's health is 503 with a body)."""
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as err:
        return err.code, err.read()


def parse(body: bytes) -> dict:
    try:
        value = json.loads(body)
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def post_json(url: str, body: dict) -> urllib.request.addinfourl:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {KEY}"},
        method="POST",
    )
    return urllib.request.urlopen(req, timeout=30)


def check(name: str, ok: bool, detail: str = "") -> bool:
    print(f"{'PASS' if ok else 'FAIL'} {name}{': ' + detail if detail else ''}")
    return ok


def main() -> int:
    results = []

    status, body = get(UI + "/")
    results.append(check("ui serves index", status == 200 and b"<div id=\"app\"" in body))

    status, body = get(UI + "/api/health")
    health = parse(body)
    results.append(check("ui proxies api health", status == 200 and health.get("db") == "up",
                         f"HTTP {status} {json.dumps(health)}"))

    status, body = get(API + "/api/health")
    health = parse(body)
    results.append(check("api health direct", status == 200, f"HTTP {status} {body.decode()}"))
    # The plain-words problem names each folder the API cannot write and how to fix it.
    results.append(check("api can write runs/, labels/ and configs/prompts/",
                         health.get("files") == "writable",
                         health.get("files_problem") or f"files: {health.get('files')!r}"))

    marker = "smoke-" + os.urandom(4).hex()
    with post_json(LITELLM + "/v1/chat/completions", {
        "model": "fake/echo",
        "messages": [{"role": "user", "content": f"hello {marker}"}],
        "temperature": 0.3,
    }) as resp:
        reply = json.loads(resp.read())
    content = reply["choices"][0]["message"]["content"]
    results.append(check("litellm -> fake, plain", bool(content), repr(content)[:80]))

    with post_json(LITELLM + "/v1/chat/completions", {
        "model": "fake/echo",
        "messages": [{"role": "user", "content": f"stream {marker}"}],
        "stream": True,
    }) as resp:
        raw = resp.read().decode()
    events = [line[6:] for line in raw.splitlines() if line.startswith("data: ")]
    results.append(check("litellm -> fake, streamed", bool(events) and events[-1] == "[DONE]",
                         f"{len(events)} events"))

    # The settings test in miniature: did our temperature reach the model?
    # The fake server is internal-only, so read its capture from inside the network.
    results.append(check("temperature reached the fake server", fake_saw_temperature(marker, 0.3)))

    return 0 if all(results) else 1


def fake_saw_temperature(marker: str, temperature: float) -> bool:
    import subprocess

    out = subprocess.run(
        ["docker", "compose", "-p", PROJECT, "exec", "-T", "fake-llm", "python", "-c",
         "import urllib.request,sys;"
         "sys.stdout.write(urllib.request.urlopen('http://localhost:8080/_fake/requests').read().decode())"],
        capture_output=True, text=True, check=True,
    ).stdout
    data = json.loads(out)
    rows = data if isinstance(data, list) else data.get("requests", [])
    for row in rows:
        body = row.get("body", {})
        if marker in json.dumps(body.get("messages", [])) and body.get("temperature") == temperature:
            return True
    return False


if __name__ == "__main__":
    sys.exit(main())
