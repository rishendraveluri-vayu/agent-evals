"""Compose smoke test: the running stack answers end to end, with no LLM spend.

Assumes `docker compose up -d --wait` has run. Standard library only.
Run: python3 scripts/smoke.py

Checks:
- the UI serves its page, and proxies /api/health to the API with the database up;
- LiteLLM routes a fake model to the fake server, both plain and streamed;
- the request that reached the fake server carried the temperature we sent.
"""

import json
import os
import sys
import urllib.request

UI = os.environ.get("SMOKE_UI_URL", "http://127.0.0.1:8080")
API = os.environ.get("SMOKE_API_URL", "http://127.0.0.1:3000")
LITELLM = os.environ.get("SMOKE_LITELLM_URL", "http://127.0.0.1:4000")
KEY = os.environ.get("LITELLM_MASTER_KEY", "sk-local-dev-only")


def get(url: str) -> tuple[int, bytes]:
    with urllib.request.urlopen(url, timeout=10) as resp:
        return resp.status, resp.read()


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
    health = json.loads(body)
    results.append(check("ui proxies api health", status == 200 and health.get("db") == "up",
                         json.dumps(health)))

    status, body = get(API + "/api/health")
    results.append(check("api health direct", status == 200, body.decode()))

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
        ["docker", "compose", "exec", "-T", "fake-llm", "python", "-c",
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
