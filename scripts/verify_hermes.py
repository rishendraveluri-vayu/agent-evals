"""D39: check what we claim about Hermes, trial by trial, from what the trials actually recorded.

    python3 scripts/verify_hermes.py <experiment_id> [<experiment_id> ...] [--api URL]

For every finished trial it reads the stored files through the API and checks:
- the task prompt reaches the model inside Hermes's system prompt (D20: kept, never stripped);
- no "Parallel tool calls" guidance while parallel_tool_calls is false (D33);
- no prompt-cache markers in any request (D31);
- memory: no memory tool or block when off; the tool but no seeded text when on and empty; every
  seeded entry in the prompt when seeded;
- tools: exactly the config's toolset (finance/all: the 11 finance tools; finance/v2 since 5 Nov:
  those plus the 7 arithmetic tools, D54; finance/v3: those plus reference_rates, D58;
  finance-no-calculators/v3: finance/v3 without the 8 calculators, D70), plus the
  memory tool only when memory is on. A Hermes image built before a toolset's tools would show
  its configs fewer tools, and this catches it;

- LiteLLM's call count against Hermes's own (R10.9), and that LiteLLM's log was complete;
- compression never fired;
- Hermes's config files are unchanged after the trial (integrity hashes);
- the provenance check ran (checks.json) and how many amounts had no tool behind them.
Prints one line per trial and a summary per memory mode. Reads only; spends nothing.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

FINANCE = {
    "calculate_emi", "amortization_schedule", "prepayment_impact", "debt_payoff_plan",
    "sip_future_value", "fd_maturity", "inflation_adjusted_value", "loan_affordability",
    "get_client_profile", "list_debts", "list_transactions",
}
ARITHMETIC = {"add", "subtract", "multiply", "divide", "percent_of", "percent_change", "round"}
CALCULATORS = {
    "calculate_emi", "amortization_schedule", "prepayment_impact", "debt_payoff_plan",
    "sip_future_value", "fd_maturity", "inflation_adjusted_value", "loan_affordability",
}
# The tools each toolset (id, version) gives the model (apps/api/src/catalogue/catalogue-files.ts).
REFERENCE = {"reference_rates"}
TOOLSETS = {
    ("finance", "all"): FINANCE,
    ("finance", "v2"): FINANCE | ARITHMETIC,
    ("finance", "v3"): FINANCE | ARITHMETIC | REFERENCE,
    # D70's positive control: finance/v3 without the calculators, so a calculator here is extra.
    ("finance-no-calculators", "v3"): (FINANCE | ARITHMETIC | REFERENCE) - CALCULATORS,
}
PROMPT_FILE = Path(__file__).resolve().parents[1] / "configs" / "prompts" / "finance-advisor.v1.md"


def get(api: str, path: str, raw: bool = False):
    with urllib.request.urlopen(api + path, timeout=60) as r:
        data = r.read()
    return data.decode("utf-8", "replace") if raw else json.loads(data)


def prompt_text() -> str:
    t = PROMPT_FILE.read_text()
    if t.startswith("<!--"):
        t = t[t.index("-->") + 3:]
    return t.strip()


def bare(name: str) -> str:
    return name.split("__")[-1] if name.startswith("mcp__") else name


def check(api: str, trial: dict, cfg: dict, ours: str) -> dict:
    tid = trial["id"]
    detail = get(api, f"/trials/{tid}")
    files = {f["path"]: f for f in detail.get("files") or []}
    def read(suffix: str) -> str | None:
        for p in files:
            if p.endswith(suffix):
                return get(api, f"/trials/{tid}/files/{urllib.parse.quote(p)}", raw=True)
        return None
    req = read("artifacts/proxy/0001.request.json")
    out: dict = {"trial": tid, "task": trial.get("task_id"), "label": trial.get("label"), "end": trial.get("end_state")}
    if req is None:
        out["error"] = "no stored first request"
        return out
    body = json.loads(req)
    system = next((m.get("content") for m in body.get("messages", []) if m.get("role") == "system"), "") or ""
    if isinstance(system, list):
        system = "".join(p.get("text", "") for p in system if isinstance(p, dict))
    tools = {bare(t["function"]["name"]) for t in body.get("tools", [])}
    memory_on = bool((cfg["settings"].get("memory") or {}).get("enabled"))
    seeds = (cfg.get("seed") or {}).get("memory") or []
    all_reqs = [read(p[len("out/"):] if p.startswith("out/") else p) for p in files if re.search(r"proxy/\d{4}\.request\.json$", p)]
    out["prompt_kept"] = ours[:200] in system and ours[-200:] in system
    out["no_parallel_section"] = "Parallel tool calls" not in system
    out["no_cache_markers"] = all('"cache_control"' not in (r or "") for r in all_reqs)
    toolset = cfg.get("toolset") or {}
    key = (toolset.get("id"), toolset.get("version"))
    finance = TOOLSETS.get(key)
    if finance is None:
        out["error"] = f"no tool list for toolset {key!r}; add it to TOOLSETS"
        return out
    extra = tools - finance
    out["finance_tools"] = finance <= tools
    out["missing_tools"] = sorted(finance - tools)
    out["extra_tools"] = sorted(extra)
    out["tools_ok"] = finance <= tools and (extra == ({"memory"} if memory_on else set()))
    if not memory_on:
        out["memory_ok"] = "memory" not in tools and "MEMORY" not in system
    elif not seeds:
        out["memory_ok"] = "memory" in tools and not any(s[:40] in system for s in [
            "Meera Raghavan wants to clear", "Meera's mother's medical costs", "Meera prefers short"])
    else:
        out["memory_ok"] = "memory" in tools and all(s[:60] in system for s in seeds)
    report = detail.get("runner_report") or {}
    usage = report.get("proxy_usage") or {}
    result = detail.get("result") or {}
    out["proxy_calls"] = usage.get("model_calls")
    out["hermes_calls"] = (result.get("counts") or {}).get("model_calls")
    out["log_complete"] = usage.get("complete")
    spans = get(api, f"/trials/{tid}/spans")
    events = [e.get("name") for s in spans for e in (s.get("events") or [])]
    out["no_compression"] = not any((n or "").startswith("evals.compression") for n in events)
    integ = result.get("integrity") or {}
    before, after = integ.get("before") or {}, integ.get("after") or {}
    out["config_unchanged"] = bool(before) and before == after
    checks = read("checks.json")
    if checks:
        c = json.loads(checks)
        out["unsupported_amounts"] = c.get("unsupported", (c.get("provenance") or {}).get("unsupported"))
    else:
        out["unsupported_amounts"] = "no checks.json"
    return out


BOOLS = ("prompt_kept", "no_parallel_section", "no_cache_markers", "tools_ok", "memory_ok", "log_complete", "no_compression", "config_unchanged")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("experiments", nargs="+")
    ap.add_argument("--api", default="http://127.0.0.1:3001/api")
    ap.add_argument("--json", type=Path, help="also write every row here")
    args = ap.parse_args()
    api = args.api.rstrip("/")
    ours = prompt_text()
    rows, by_mode = [], defaultdict(list)
    for eid in args.experiments:
        exp = get(api, f"/experiments/{eid}")
        cfg = get(api, f"/configs/{exp['config_hashes'][0]}")
        mode = cfg["name"].split(", ", 1)[-1]
        for t in get(api, f"/experiments/{eid}/trials"):
            if t["status"] != "done":
                continue
            r = check(api, t, cfg, ours)
            r["mode"] = mode
            rows.append(r)
            by_mode[mode].append(r)
            fails = [k for k in BOOLS if r.get(k) is False]
            print(f"{mode:18s} {r['task']:30s} {r['label']}/{r['end']} calls proxy {r.get('proxy_calls')} hermes {r.get('hermes_calls')} "
                  f"unsupported {r.get('unsupported_amounts')} {'OK' if not fails and 'error' not in r else 'FAIL ' + ','.join(fails) + r.get('error', '')}")
    print()
    for mode, rs in by_mode.items():
        summary = {k: f"{sum(1 for r in rs if r.get(k) is True)}/{len(rs)}" for k in BOOLS}
        extra_calls = sum((r.get("proxy_calls") or 0) - (r.get("hermes_calls") or 0) for r in rs)
        print(f"{mode}: {len(rs)} trials; " + ", ".join(f"{k} {v}" for k, v in summary.items()) + f"; proxy minus Hermes calls {extra_calls}")
    if args.json:
        args.json.write_text(json.dumps(rows, indent=2))
    return 0 if all(not [k for k in BOOLS if r.get(k) is False] for r in rows) else 1


if __name__ == "__main__":
    sys.exit(main())
