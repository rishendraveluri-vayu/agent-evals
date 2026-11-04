"""Fail if docker-compose.yml would let workers in with the wrong token.

Run: uv run --no-project --with pyyaml==6.0.3 python scripts/check_compose.py [FILE]

Checks, with compose's `${NAME:-default}` filled in the way compose fills it:
- the API and every harness worker read the worker token from the one variable
  EVALS_WORKER_TOKEN, and with it unset (out of the box) they get the same non-empty
  default, so a worker is never refused by a fresh stack.
"""

import re
import sys
from pathlib import Path

import yaml

COMPOSE = Path(__file__).resolve().parent.parent / "docker-compose.yml"
TOKEN = "EVALS_WORKER_TOKEN"
VAR = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)([^}]*))?\}")


def interpolate(value: str, env: dict[str, str]) -> str:
    """`${NAME}`, `${NAME:-default}` (unset or empty) and `${NAME-default}` (unset), as compose."""

    def fill(m: re.Match) -> str:
        name, op, default = m.group(1), m.group(2), m.group(3) or ""
        if op == ":-":
            return env.get(name) or default
        if op == "-":
            return env.get(name, default)
        return env.get(name, "")

    return VAR.sub(fill, value)


def environment(service: dict) -> dict[str, str]:
    env = service.get("environment") or {}
    if isinstance(env, list):
        env = dict(item.split("=", 1) if "=" in item else (item, "") for item in env)
    return {k: "" if v is None else str(v) for k, v in env.items()}


def workers(cfg: dict) -> dict[str, dict]:
    return {n: s for n, s in (cfg.get("services") or {}).items() if n.startswith("worker-")}


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


def problems(cfg: dict) -> list[str]:
    return token_problems(cfg)


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
