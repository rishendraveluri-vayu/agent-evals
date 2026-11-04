"""Fail if docker-compose.yml would refuse workers or let trials share stored files.

Run: uv run --no-project --with pyyaml==6.0.3 python scripts/check_compose.py [FILE]

Checks, with compose's `${NAME:-default}` filled in the way compose fills it:
- the API, every harness worker and the grader read the worker token from the one variable
  EVALS_WORKER_TOKEN, and with it unset (out of the box) they get the same non-empty
  default, so a worker is never refused by a fresh stack;
- no worker (nor netcheck, which checks the worker runtime) mounts runs/ or anything else
  from the host: workers upload trial files to the API (D2), so a trial cannot read or
  change another trial's stored folder (D3);
- the API mounts runs/ read-write, since it alone stores the uploaded files;
- provider keys reach LiteLLM only: no other service names ANTHROPIC_API_KEY or GEMINI_API_KEY
  except the API's set/unset flags (`ANTHROPIC_KEY_SET: ${ANTHROPIC_API_KEY:+1}`), which are
  "1" with a key and empty without one, never the key itself.
"""

import re
import sys
from pathlib import Path

import yaml

COMPOSE = Path(__file__).resolve().parent.parent / "docker-compose.yml"
TOKEN = "EVALS_WORKER_TOKEN"
VAR = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+])([^}]*))?\}")
# Each provider key LiteLLM holds, and the flag the API gets instead of it.
PROVIDER_KEYS = {"ANTHROPIC_API_KEY": "ANTHROPIC_KEY_SET", "GEMINI_API_KEY": "GEMINI_KEY_SET"}


def interpolate(value: str, env: dict[str, str]) -> str:
    """`${NAME}`, `${NAME:-default}` (unset or empty), `${NAME-default}` (unset), `${NAME:+word}`
    (word when set and not empty) and `${NAME+word}` (word when set), as compose fills them."""

    def fill(m: re.Match) -> str:
        name, op, word = m.group(1), m.group(2), m.group(3) or ""
        if op == ":-":
            return env.get(name) or word
        if op == "-":
            return env.get(name, word)
        if op == ":+":
            return word if env.get(name) else ""
        if op == "+":
            return word if name in env else ""
        return env.get(name, "")

    return VAR.sub(fill, value)


def environment(service: dict) -> dict[str, str]:
    env = service.get("environment") or {}
    if isinstance(env, list):
        env = dict(item.split("=", 1) if "=" in item else (item, "") for item in env)
    return {k: "" if v is None else str(v) for k, v in env.items()}


def workers(cfg: dict) -> dict[str, dict]:
    """Harness workers, and the grader (SP4), which uses the same token and mounts nothing."""
    services = cfg.get("services") or {}
    return {n: s for n, s in services.items() if n.startswith("worker-") or n == "grader"}


def token_problems(cfg: dict) -> list[str]:
    found = []
    services = cfg.get("services") or {}
    api = services.get("api")
    if api is None:
        return ["there is no api service"]
    if not workers(cfg):
        found.append("there are no worker-* services")
    raw = {"api": environment(api).get(TOKEN)}
    raw.update({name: environment(s).get(TOKEN) for name, s in workers(cfg).items()})
    for name, value in raw.items():
        if value is None:
            found.append(f"{name} does not set {TOKEN}")
        elif f"${{{TOKEN}" not in value:
            found.append(f"{name} sets {TOKEN} to a fixed value instead of from ${{{TOKEN}}}")
    if found:
        return found
    for label, env in (("unset", {}), ("set", {TOKEN: "wt-check-value"})):
        seen = {name: interpolate(value, env) for name, value in raw.items()}
        if not seen["api"]:
            found.append(f"with {TOKEN} {label}, the API's worker token is empty")
        for name, value in seen.items():
            if value != seen["api"]:
                found.append(
                    f"with {TOKEN} {label}, {name} sends {value!r} but the API expects "
                    f"{seen['api']!r}"
                )
    return found


def mounts(service: dict) -> list[tuple[str, str, bool]]:
    """(source, target, read_only) for each volume, short or long syntax."""
    rows = []
    for v in service.get("volumes") or []:
        if isinstance(v, str):
            parts = v.split(":")
            source, target = (parts[0], parts[1]) if len(parts) > 1 else ("", parts[0])
            rows.append((source, target, len(parts) > 2 and "ro" in parts[2].split(",")))
        else:
            source, target = str(v.get("source", "")), str(v.get("target", ""))
            rows.append((source, target, bool(v.get("read_only"))))
    return rows


def runs_problems(cfg: dict) -> list[str]:
    found = []
    services = cfg.get("services") or {}
    isolated = dict(workers(cfg))
    if "netcheck" in services:
        isolated["netcheck"] = services["netcheck"]
    for name, service in isolated.items():
        for source, target, _ in mounts(service):
            found.append(f"{name} mounts {source or 'a volume'} at {target}; workers mount nothing")
        if service.get("group_add"):
            found.append(f"{name} sets group_add, which only the old runs/ mount needed")
    api_runs = [m for m in mounts(services.get("api") or {}) if m[1] == "/runs"]
    if not api_runs:
        found.append("the api does not mount runs/ at /runs")
    elif api_runs[0][2]:
        found.append("the api mounts runs/ read-only, but it stores the uploaded trial files")
    return found


def key_problems(cfg: dict) -> list[str]:
    """Provider keys go to LiteLLM alone; the API gets a set/unset flag per key, never the key."""
    found = []
    services = cfg.get("services") or {}
    secret = "sk-check-secret-value"
    for name, service in services.items():
        if name == "litellm":
            continue
        for var, value in environment(service).items():
            for key in PROVIDER_KEYS:
                if var == key:
                    found.append(f"{name} sets {key}; only LiteLLM may hold a provider key")
                elif secret in interpolate(value, {key: secret}):
                    found.append(
                        f"{name}'s {var} would carry the value of {key}; "
                        f"pass a flag (${{{key}:+1}}) instead"
                    )
    api = environment(services.get("api") or {})
    for key, flag in PROVIDER_KEYS.items():
        raw = api.get(flag)
        if raw is None:
            found.append(f"the api does not set {flag}, so it cannot tell that {key} is missing")
            continue
        with_key, without = interpolate(raw, {key: secret}), interpolate(raw, {})
        if not with_key or secret in with_key or without:
            found.append(
                f"the api's {flag} must be non-empty with {key} set and empty without it "
                f"(got {with_key!r} and {without!r})"
            )
    return found


def problems(cfg: dict) -> list[str]:
    return token_problems(cfg) + runs_problems(cfg) + key_problems(cfg)


def main(argv: list[str]) -> int:
    path = Path(argv[0]) if argv else COMPOSE
    found = problems(yaml.safe_load(path.read_text()))
    for item in found:
        print(f"FAIL: {item}")
    if not found:
        print(f"OK: {path.name}")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
