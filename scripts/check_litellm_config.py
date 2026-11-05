"""Fail if the LiteLLM config could make trials unfaithful.

Run: uv run --no-project --with pyyaml==6.0.3 python scripts/check_litellm_config.py

Checks:
- the response cache is off (CLAUDE.md: a cached reply makes repeated trials
  stop being independent samples);
- drop_params is off, so an unsupported setting fails loudly instead of being
  silently dropped;
- the proxy's retries are bounded (D16): `num_retries` and every per-error
  count in `retry_policy` are 3 or fewer, so a failing call cannot run up
  attempts, time or spend without limit;
- backoff is set: `retry_after` (LiteLLM's floor under its exponential backoff)
  is at least 1 second, so a retry never hammers a provider that just refused;
- 4xx errors other than 429 are never retried: `retry_policy` sets
  BadRequestErrorRetries and AuthenticationErrorRetries to 0 (D26 labels those
  infra:config_error or the agent's outcome, and retrying cannot fix them);
- each call has a bounded `timeout` (and `stream_timeout`), so one hung call
  fails as a timeout instead of eating the trial;
- every model states its own prices. LiteLLM v1.99.4's bundled price map has
  no Haiku 5.5 or Gemini 3.8 Flash, so without explicit prices their spend
  would count as $0 and per-trial budget caps would never trip.

LiteLLM v1.99.4 limits what the policy can say (read in its router.py): it has
no retry_policy key for 403 or 404. A 404 is never retried whatever the policy,
and a 403 that LiteLLM maps to BadRequestError (as on the fake's OpenAI route,
tested 4 Nov) is not either; one it maps to PermissionDeniedError can be. See
docs/known-limits.md.
"""

import sys
from pathlib import Path

import yaml

CONFIG = Path(__file__).resolve().parent.parent / "services" / "litellm" / "config.yaml"

MAX_RETRIES = 3
MAX_TIMEOUT_S = 600
# 4xx errors other than 429 that retry_policy can name; each must be 0.
NEVER_RETRIED = ("BadRequestErrorRetries", "AuthenticationErrorRetries")


def _int(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def retry_problems(router: dict) -> list[str]:
    found = []
    num = _int(router.get("num_retries"))
    if num is None or not 0 <= num <= MAX_RETRIES:
        found.append(f"router_settings.num_retries must be an integer from 0 to {MAX_RETRIES}")
    after = router.get("retry_after")
    if isinstance(after, bool) or not isinstance(after, int | float) or after < 1:
        found.append("router_settings.retry_after (the backoff floor) must be at least 1 second")
    policy = router.get("retry_policy")
    if not isinstance(policy, dict):
        found.append("router_settings.retry_policy must be set")
        policy = {}
    for name, value in policy.items():
        count = _int(value)
        if count is None or not 0 <= count <= MAX_RETRIES:
            found.append(f"retry_policy.{name} must be an integer from 0 to {MAX_RETRIES}")
    for name in NEVER_RETRIED:
        if policy.get(name) != 0:
            found.append(f"retry_policy.{name} must be 0: only 429 among 4xx errors is retried")
    for field in ("timeout", "stream_timeout"):
        value = router.get(field)
        if isinstance(value, bool) or not isinstance(value, int | float):
            found.append(f"router_settings.{field} must be set (seconds per call)")
        elif not 0 < value <= MAX_TIMEOUT_S:
            found.append(f"router_settings.{field} must be above 0 and at most {MAX_TIMEOUT_S} s")
    if "model_group_retry_policy" in router:
        found.append("router_settings.model_group_retry_policy must not be set (one policy)")
    return found


def problems(cfg: dict) -> list[str]:
    found = []
    settings = cfg.get("litellm_settings") or {}
    if settings.get("cache") not in (False, None):
        found.append("litellm_settings.cache must be false or absent")
    if "cache_params" in settings:
        found.append("litellm_settings.cache_params must not be set")
    if settings.get("drop_params") is not False:
        found.append("litellm_settings.drop_params must be explicitly false")
    if "num_retries" in settings:
        found.append("litellm_settings.num_retries must not be set; retries are router_settings")
    found += retry_problems(cfg.get("router_settings") or {})
    for entry in cfg.get("model_list") or []:
        params = entry.get("litellm_params") or {}
        name = entry.get("model_name")
        if params.get("cache") or params.get("caching"):
            found.append(f"model {name} turns caching on")
        for field in ("num_retries", "max_retries"):
            if field in params:
                found.append(f"model {name} sets {field}; retries live in router_settings")
        info = entry.get("model_info") or {}
        # A model served by a local Ollama costs nothing per token, so 0 is its true price;
        # every other model must be priced above 0, so a real model can never slip in unpriced.
        local = str(params.get("model", "")).startswith(("ollama/", "ollama_chat/"))
        for field in ("input_cost_per_token", "output_cost_per_token"):
            value = info.get(field)
            if not isinstance(value, (int, float)) or value < 0 or (value == 0 and not local):
                found.append(f"model {name} needs model_info.{field} > 0")
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
