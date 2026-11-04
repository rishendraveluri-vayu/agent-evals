"""Real-model smoke trials for one harness: does it work end to end on a real model?

Run from a worker folder, inside its environment (it reuses that worker's gate):

    cd workers/ownloop && uv run python ../../scripts/real_smoke.py \
        --model claude-haiku-5-5 --out ../../runs/<stamp>-real/ownloop/claude-haiku-5-5 --cap-usd 3

REAL MONEY. Every run needs Rishi's sign-off with an estimate first (R8). Use
--model fake/finance-emi to rehearse it against the fake model, at no cost.

Three trials, all through LiteLLM with a per-trial key and budget:
- single: one client question that needs the profile, the debts and a payoff plan;
- conversation: the same client played by the simulated client (D22), 3 turns at most;
- settings: temperature and max tokens set, to see whether the model accepts them.

The finance-advisor v1 prompt is the system prompt. Prints one line per trial and
writes summary.json next to the trials. Stops early once spend passes --cap-usd.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, "tests")
from test_gate import GATE  # noqa: E402

from evals_adapter.gate import REPO, SIM_KEY_ENV, SIM_PROMPT_FILE, prompt_text, proxy_gate  # noqa: E402
from evals_adapter.trace import attr_dict  # noqa: E402

ADVISOR = REPO / "configs" / "prompts" / "finance-advisor.v1.md"
QUESTION = (
    "My mother's medical costs went up this year and I'm falling behind on my credit card. "
    "I can put about Rs 20,000 a month towards my debts. What should I pay off first, "
    "and how long will it take?"
)
OPENING = "Hi. I don't really know where to start with my money. Can you help me?"


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def build(gate, trial_dir: Path, model: str, scenario: str, sim_model: str) -> dict:
    unset = {"temperature": None, "max_output_tokens": 4096, "max_steps": 12, "timeout_s": 240}
    if scenario == "settings":
        settings = {**unset, "temperature": 0.37, "max_output_tokens": 777}
    elif scenario == "conversation":
        settings = {**unset, "max_steps": 24, "timeout_s": 420}
    else:
        settings = unset
    spec = gate.spec(trial_dir, "smoke", None, **settings)
    advisor = prompt_text(ADVISOR)
    spec["system_prompt"] = {
        "id": "finance-advisor",
        "version": "v1",
        "sha256": sha(advisor),
        "text": advisor,
    }
    spec["model"]["name"] = model
    spec["trial"]["task_id"] = f"smoke-{scenario}"
    spec["trial"]["config_id"] = f"smoke-{gate.harness}-{model}"
    spec["task"]["messages"] = [{"role": "user", "content": QUESTION}]
    if scenario == "conversation":
        sim_prompt = prompt_text(SIM_PROMPT_FILE)
        spec["task"]["messages"] = [{"role": "user", "content": OPENING}]
        spec["task"]["client_sim"] = {
            "persona": (
                "Meera Raghavan, 34, a QA engineer in Pune who supports her son, 6, and her "
                "mother, 63. Practical, a little anxious about money, answers what she is asked."
            ),
            "hidden_facts": [
                "Her mother's medical bills are now about Rs 8,000 a month",
                "She can put about Rs 20,000 a month towards her debts",
            ],
            "concerns": ["Am I going to fall behind on the credit card?"],
            "goal": "A clear order to pay off her debts and a monthly plan she can follow",
            "opening_message": OPENING,
            "max_client_turns": 3,
            "model": {
                "name": sim_model,
                "base_url": spec["model"]["base_url"],
                "api_key_env": SIM_KEY_ENV,
                # D22 asks for temperature 0, but Haiku 5.5 is documented to reject any
                # non-default value. 1 is its default; the reply cache keeps it repeatable.
                "temperature": 1 if sim_model.startswith("claude-haiku-5") else 0,
                "max_output_tokens": 1500,
                "prompt": {
                    "id": "client-sim",
                    "version": "v1",
                    "sha256": sha(sim_prompt),
                    "text": sim_prompt,
                },
            },
        }
    return spec


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--sim-model", default="claude-haiku-5-5")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--cap-usd", type=float, required=True)
    ap.add_argument("--trial-budget-usd", type=float, default=0.5)
    ap.add_argument("--scenarios", default="single,conversation,settings")
    args = ap.parse_args()
    # The adapter runs with the trial folder as its cwd, so every path must be absolute.
    args.out = args.out.resolve()
    gate = proxy_gate(GATE, budget_usd=args.trial_budget_usd)
    if gate is None:
        print("set EVALS_PROXY_URL and LITELLM_MASTER_KEY", file=sys.stderr)
        return 2
    sim_model = args.model if args.model.startswith("fake/") else args.sim_model
    if args.model.startswith("fake/"):
        sim_model = "fake/sim-client"
    args.out.mkdir(parents=True, exist_ok=True)
    spent, rows = 0.0, []
    for scenario in args.scenarios.split(","):
        if spent >= args.cap_usd:
            print(f"stopping: spent ${spent:.4f} of the ${args.cap_usd} cap")
            break
        out = args.out / scenario
        out.mkdir()
        spec = build(gate, out / "trial", args.model, scenario, sim_model)
        run = gate.run(out, None, spec)
        usage = run.report.get("proxy_usage") or {}
        sim_cost = sum(
            float(attr_dict(s).get("evals.cost_usd") or 0)
            for s in run.spans_named("chat ")
            if attr_dict(s).get("evals.role") == "sim"
        )
        cost = float(usage.get("cost_usd") or 0) + sim_cost
        spent += cost
        conv = run.result.get("conversation") or {}
        row = {
            "harness": gate.harness,
            "model": args.model,
            "scenario": scenario,
            "end_state": run.result.get("end_state"),
            "label": run.report.get("label"),
            "proxy_calls": usage.get("model_calls"),
            "harness_calls": (run.result.get("counts") or {}).get("model_calls"),
            "cost_usd": round(cost, 6),
            "ended_by": conv.get("ended_by"),
            "client_turns": conv.get("client_turns"),
            "wall_s": round(run.wall_s, 1),
            "detail": {
                k: (str(v)[:300] if v else v)
                for k, v in (run.result.get("end_detail") or {}).items()
                if k in ("harness_stop_reason", "exception_type", "exception_message")
            },
            "last_status": usage.get("last_status"),
            "trial_dir": str(run.trial_dir),
        }
        rows.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
    (args.out / "summary.json").write_text(json.dumps(rows, indent=2, ensure_ascii=False))
    print(f"spent ${spent:.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
