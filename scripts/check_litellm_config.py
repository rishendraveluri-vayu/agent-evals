"""Fail if the LiteLLM config could make trials unfaithful.

Run: uv run --no-project --with pyyaml==6.0.3 python scripts/check_litellm_config.py

Checks:
- the response cache is off (CLAUDE.md: a cached reply makes repeated trials
  stop being independent samples);
- drop_params is off, so an unsupported setting fails loudly instead of being
  silently dropped;
- the proxy does no silent retries, so faults reach the caller and are counted;
- every model states its own prices. LiteLLM v1.99.4's bundled price map has
  no Haiku 5.5 or Gemini 3.8 Flash, so without explicit prices their spend
  would count as $0 and per-trial budget caps would never trip.
"""

import sys
from pathlib import Path

import yaml

CONFIG = Path(__file__).resolve().parent.parent / "services" / "litellm" / "config.yaml"


def problems(cfg: dict) -> list[str]:
    found = []
    settings = cfg.get("litellm_settings") or {}
    if settings.get("cache") not in (False, None):
        found.append("litellm_settings.cache must be false or absent")
    if "cache_params" in settings:
        found.append("litellm_settings.cache_params must not be set")
    if settings.get("drop_params") is not False:
        found.append("litellm_settings.drop_params must be explicitly false")
    router = cfg.get("router_settings") or {}
    if router.get("num_retries", 0) != 0:
        found.append("router_settings.num_retries must be 0 until SP3 sets a retry policy")
    for entry in cfg.get("model_list") or []:
        params = entry.get("litellm_params") or {}
        if params.get("cache") or params.get("caching"):
            found.append(f"model {entry.get('model_name')} turns caching on")
        info = entry.get("model_info") or {}
        for field in ("input_cost_per_token", "output_cost_per_token"):
            value = info.get(field)
            if not isinstance(value, (int, float)) or value <= 0:
                found.append(f"model {entry.get('model_name')} needs model_info.{field} > 0")
    return found


def main() -> int:
    cfg = yaml.safe_load(CONFIG.read_text())
    found = problems(cfg)
    for item in found:
        print(f"FAIL: {item}")
    if not found:
        print(f"OK: {CONFIG.relative_to(CONFIG.parents[2])}")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
