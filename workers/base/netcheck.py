"""Check a worker container has exactly the access D3 allows.

Run inside the worker base image with the worker runtime settings
(`docker compose --profile smoke run --rm netcheck`). Exits non-zero if any
expectation fails, and prints one JSON line per check.

Expected:
- the API, LiteLLM and the fake model server are reachable;
- the public internet is not (DNS and a direct TCP connect both fail);
- the root filesystem is read-only, and /trial is writable.
"""

import json
import os
import socket
import sys
import urllib.error
import urllib.request

REACHABLE = {
    "api": "http://api:3000/api/health",
    "litellm": "http://litellm:4000/health/liveliness",
    "fake-llm": "http://fake-llm:8080/health",
}


def http_reachable(url: str) -> tuple[bool, str]:
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            return True, f"HTTP {resp.status}"
    except urllib.error.HTTPError as err:  # any HTTP answer means the network path works
        return True, f"HTTP {err.code}"
    except OSError as err:
        return False, repr(err)


def internet_blocked() -> tuple[bool, str]:
    try:
        socket.getaddrinfo("example.com", 443)
        return False, "DNS for example.com resolved"
    except OSError:
        pass
    try:
        with socket.create_connection(("1.1.1.1", 443), timeout=3):
            return False, "TCP connect to 1.1.1.1:443 succeeded"
    except OSError as err:
        return True, f"blocked: {err!r}"


def write_allowed(path: str) -> tuple[bool, str]:
    try:
        with open(path, "w") as fh:
            fh.write("x")
        os.remove(path)
        return True, "write succeeded"
    except OSError as err:
        return False, repr(err)


def main() -> int:
    results = []
    for name, url in REACHABLE.items():
        ok, detail = http_reachable(url)
        results.append({"check": f"reach {name}", "ok": ok, "detail": detail})

    ok, detail = internet_blocked()
    results.append({"check": "internet blocked", "ok": ok, "detail": detail})

    wrote_root, detail = write_allowed("/netcheck-probe")
    results.append({"check": "root read-only", "ok": not wrote_root, "detail": detail})

    ok, detail = write_allowed("/trial/netcheck-probe")
    results.append({"check": "trial folder writable", "ok": ok, "detail": detail})

    for row in results:
        print(json.dumps(row))
    return 0 if all(row["ok"] for row in results) else 1


if __name__ == "__main__":
    sys.exit(main())
