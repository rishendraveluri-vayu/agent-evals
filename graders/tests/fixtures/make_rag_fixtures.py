"""Regenerate tests/fixtures/rag-synthetic-20261106/: SYNTHETIC trials for D79's ten retrieval
tasks, recorded through the own loop against the fake model server (no real model is called).

For each task, two scripted agents:
- `correct`: on toolset finance-rag (the 20 tools), calls search_documents and the tools the
  answer needs, and states the right figures. Every required grader must pass.
- `made-up`: on toolset finance/v3 (no search), answers from memory with a plausible wrong rate
  or fee. It must fail the critical `no-made-up-figure` check.
Conversation tasks get a scripted simulated client too. The scripts are registered with the fake
server at run time (nothing is added to services/fake-llm/scripts). The trials are synthetic:
they show the graders work, not how any model behaves, and they are never labels.

    cd workers/ownloop && uv run python ../../graders/tests/fixtures/make_rag_fixtures.py
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import urllib.request
from pathlib import Path

from evals_adapter.gate import (
    ALL_FINANCE_TOOLS,
    FINANCE_V3_TOOLS,
    SIM_KEY_ENV,
    SIM_PROMPT_FILE,
    FakeServer,
    Gate,
    _sha,
    prompt_text,
)

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
OUT = HERE / "rag-synthetic-20261106"
KEEP = ("result.json", "trace.jsonl", "runner-report.json", "checks.json")
END = "Thank you, that helps. [[END_CONVERSATION]]"


def call(name: str, **arguments: object) -> dict:
    return {"tool_calls": [{"name": name, "arguments": arguments}]}


def say(text: str) -> dict:
    return {"text": text}


# task id -> {case: (agent steps, simulated client replies or None)}
CASES: dict[str, dict[str, tuple[list[dict], list[str] | None]]] = {
    "rag-fd-two-year": {
        "correct": (
            [
                call("search_documents", query="fixed deposit rate 2 years"),
                call("fd_maturity", principal=500000, annual_rate_pct=6.95, years=2),
                say(
                    "Kaveri Bank's rate card gives 6.95% a year on a 2-year fixed deposit for the "
                    "general public. Your ₹5 lakh, compounded quarterly, grows to ₹5,73,876.57 at "
                    "maturity: ₹73,876.57 of interest."
                ),
            ],
            None,
        ),
        "made-up": (
            [
                say(
                    "Kaveri Bank pays 7.25% a year on 2-year deposits, so your ₹5 lakh grows to "
                    "about ₹5,77,000 at maturity."
                )
            ],
            None,
        ),
    },
    "rag-convo-fd-senior": {
        "correct": (
            [
                call("get_client_profile"),
                call("search_documents", query="senior citizen fixed deposit rate 3 years"),
                say(
                    "Your mother is 63, so she gets Kaveri Bank's senior citizens' rate: 7.20% a "
                    "year for a 3-year deposit. Will the deposit be in her name?"
                ),
                call("fd_maturity", principal=300000, annual_rate_pct=7.20, years=3),
                say(
                    "Then her ₹3 lakh at 7.20% for 3 years, compounded quarterly, grows to "
                    "₹3,71,616.16: ₹71,616.16 of interest."
                ),
            ],
            ["Yes, it will be in her name. She won't need the money for 3 years.", END],
        ),
        "made-up": (
            [
                say(
                    "Senior citizens get about 7.5% on a 3-year FD, so her ₹3 lakh would grow to "
                    "roughly ₹3,74,000."
                ),
                say("You're welcome."),
            ],
            ["Yes, it will be in her name.", END],
        ),
    },
    "rag-fd-break-early": {
        "correct": (
            [
                call("search_documents", query="break FD early premature withdrawal penalty"),
                call("search_documents", query="fixed deposit rate 1 year to less than 2 years"),
                call("subtract", a=6.55, b=1.00),
                call("fd_maturity", principal=200000, annual_rate_pct=5.55, years=1),
                say(
                    "If you break it now, Kaveri Bank pays the rate for 1 year to less than 2 "
                    "years, 6.55%, less a penalty of 1.00 percentage point: 5.55% for the year. "
                    "Your ₹2 lakh comes back as ₹2,11,333.16, which is ₹11,333.16 of interest."
                ),
            ],
            None,
        ),
        "made-up": (
            [
                say(
                    "Banks usually cut 1% from the rate when you break an FD, so on a 3-year FD "
                    "at about 7% you would get 6% for the year: roughly ₹2,12,270 back."
                )
            ],
            None,
        ),
    },
    "rag-personal-loan-emi": {
        "correct": (
            [
                call("search_documents", query="personal loan interest rate CIBIL score"),
                call("calculate_emi", principal=300000, annual_rate_pct=11.85, tenure_months=36),
                say(
                    "With a CIBIL score of 785, Kaveri Bank's personal loan rate is 11.85% a year, "
                    "fixed. On ₹3 lakh over 36 months your EMI is ₹9,942.81."
                ),
            ],
            None,
        ),
        "made-up": (
            [
                say(
                    "For a score above 750, Kaveri Bank charges about 10.99%, so the EMI on ₹3 "
                    "lakh over 3 years is around ₹9,820."
                )
            ],
            None,
        ),
    },
    "rag-processing-fee": {
        "correct": (
            [
                call("search_documents", query="processing fee personal loan"),
                call("percent_of", value=600000, percent=1.75),
                say(
                    "Kaveri Bank's processing fee on a personal loan is 1.75% of the loan amount, "
                    "at least ₹2,999 and at most ₹17,500, before GST. On your ₹6 lakh loan that "
                    "is ₹10,500, with GST added at the rate in force."
                ),
            ],
            None,
        ),
        "made-up": (
            [
                say(
                    "Banks usually charge 2% as a processing fee, so expect a fee of ₹12,000 "
                    "plus 18% GST."
                )
            ],
            None,
        ),
    },
    "rag-personal-loan-foreclose": {
        "correct": (
            [
                call("search_documents", query="personal loan foreclosure charge"),
                call("percent_of", value=346500, percent=4.50),
                say(
                    "Yes. Kaveri Bank charges 4.50% of the principal outstanding to close a "
                    "personal loan after 6 to 12 EMIs, and you have paid 8. On ₹3,46,500 that is "
                    "₹15,592.50, before GST."
                ),
            ],
            None,
        ),
        "made-up": (
            [
                say(
                    "Most lenders charge 4% plus GST to foreclose, so the foreclosure charge "
                    "would be ₹13,860 plus GST."
                )
            ],
            None,
        ),
    },
    "rag-home-loan-repo-linked": {
        "correct": (
            [
                call("search_documents", query="home loan interest rate repo linked"),
                call("search_documents", query="RBI policy repo rate"),
                call("add", values=[5.50, 2.65]),
                call("calculate_emi", principal=4000000, annual_rate_pct=8.15, tenure_months=240),
                say(
                    "Kaveri Bank's home loan rate is the RBI repo rate, 5.50%, plus 2.65 "
                    "percentage points, with no extra spread for a CIBIL score of 790: 8.15% a "
                    "year today, floating. On ₹40 lakh over 20 years the EMI is ₹33,831.98."
                ),
            ],
            None,
        ),
        "made-up": (
            [
                say(
                    "Home loans are around 8.5% now for good scores, so the EMI on ₹40 lakh for "
                    "20 years is about ₹34,713."
                )
            ],
            None,
        ),
    },
    "rag-tax-new-regime": {
        "correct": (
            [
                call("search_documents", query="income tax slabs new regime 2026-27"),
                call("percent_of", value=400000, percent=5),
                call("percent_of", value=400000, percent=10),
                call("percent_of", value=400000, percent=15),
                call("subtract", a=1800000, b=1600000),
                call("percent_of", value=200000, percent=20),
                call("add", values=[20000, 40000, 60000, 40000]),
                say(
                    "On the new regime's slabs for tax year 2026-27, income up to ₹4,00,000 is "
                    "taxed at nil. The next ₹4,00,000 at 5% is ₹20,000; the band from "
                    "₹8,00,001 to ₹12,00,000 at 10% is ₹40,000; the band to ₹16,00,000 at 15% is "
                    "₹60,000; and the ₹2,00,000 above that at 20% is ₹40,000. Your tax on the "
                    "slabs is ₹1,60,000, before any cess."
                ),
            ],
            None,
        ),
        "made-up": (
            [
                say(
                    "Under the new regime the slabs are nil up to ₹3 lakh, 5% to ₹7 lakh, 10% to "
                    "₹10 lakh, 15% to ₹12 lakh, 20% to ₹15 lakh and 30% above, so on ₹18 lakh "
                    "your tax is ₹2,30,000."
                )
            ],
            None,
        ),
    },
    "rag-convo-two-wheeler-bonus": {
        "correct": (
            [
                call("list_debts"),
                call("search_documents", query="two-wheeler loan foreclosure charge"),
                say(
                    "Kaveri Bank lets you close a two-wheeler loan once 6 EMIs are paid. The "
                    "charge is 4.75% of the principal outstanding if you have paid 6 to 12 EMIs, "
                    "and 2.75% after 13 or more. How many EMIs have you paid?"
                ),
                call("percent_of", value=46800, percent=2.75),
                say(
                    "Then the foreclosure charge is 2.75% of the ₹46,800 outstanding: ₹1,287, "
                    "plus GST. Before you do it, though: your credit card at 42% a year costs far "
                    "more than the two-wheeler loan at 11%, so the bonus saves more on the card."
                ),
            ],
            ["I've paid 21 EMIs so far; 15 are left.", END],
        ),
        "made-up": (
            [
                say(
                    "Banks usually charge 3% to close a two-wheeler loan early, so the charge "
                    "would be about ₹1,400."
                ),
                say("You're welcome."),
            ],
            ["I've paid 21 EMIs so far.", END],
        ),
    },
    "rag-convo-card-late-fee": {
        "correct": (
            [
                call("list_debts"),
                call("search_documents", query="credit card late payment fee"),
                say(
                    "I'm sorry about your mother's hospital bills; that is a lot at once. If the "
                    "minimum amount due is not paid by the due date, Kaveri Bank charges a late "
                    "payment fee of ₹1,375, because your total due, ₹84,250, is above ₹50,000. "
                    "Interest at 42% a year also runs on whatever is unpaid. Can you manage the "
                    "minimum this month?"
                ),
                say(
                    "Then pay at least the minimum, ₹4,212.50, before the due date: that avoids "
                    "the ₹1,375 late fee. Interest still runs on the rest, so clear it as soon "
                    "as the hospital bills settle."
                ),
            ],
            ["I can pay the minimum, but not the full bill.", END],
        ),
        "made-up": (
            [
                say(
                    "Card late fees are usually around ₹1,000, plus interest of about 3.6% a "
                    "month on the unpaid balance."
                ),
                say("You're welcome."),
            ],
            ["I can pay the minimum, but not the full bill.", END],
        ),
    },
}


def register(fake: FakeServer, name: str, steps: list[dict]) -> None:
    body = json.dumps({"name": name, "steps": steps}).encode()
    req = urllib.request.Request(
        f"http://127.0.0.1:{fake.port}/_fake/scripts",
        data=body,
        method="POST",
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=5) as resp:  # noqa: S310
        assert resp.status in (200, 201)


def gate() -> Gate:
    caps = REPO / "workers" / "ownloop" / "src" / "ownloop" / "capabilities.json"
    return Gate(
        harness="ownloop",
        adapter_cmd=[sys.executable, "-m", "ownloop.adapter"],
        capabilities=json.loads(caps.read_text()),
    )


def spec_for(
    g: Gate,
    fake: FakeServer,
    trial_dir: Path,
    task: dict,
    case: str,
    script: str,
    sim_script: str | None,
) -> dict:
    spec = g.spec(trial_dir, script, fake)
    spec["trial"]["id"] = f"rag-synthetic-{task['id']}-{case}"
    spec["trial"]["task_id"] = task["id"]
    spec["task"]["messages"] = task["messages"]
    spec["task"]["required_tools"] = task.get("required_tools") or []
    rag = case == "correct"
    allowed = list(ALL_FINANCE_TOOLS if rag else FINANCE_V3_TOOLS)
    spec["tools"]["toolset"] = {
        "id": "finance-rag" if rag else "finance",
        "version": "v1" if rag else "v3",
        "sha256": _sha(",".join(allowed)),
    }
    spec["tools"]["mcp_servers"][0]["allowed_tools"] = allowed
    if sim_script:
        prompt = prompt_text(SIM_PROMPT_FILE)
        spec["task"]["client_sim"] = {
            **task["client_sim"],
            "model": {
                "name": f"fake/{sim_script}",
                "base_url": g.base_url(fake),
                "api_key_env": SIM_KEY_ENV,
                "temperature": 0,
                "max_output_tokens": 300,
                "prompt": {
                    "id": "client-sim",
                    "version": "sim-v1",
                    "sha256": _sha(prompt),
                    "text": prompt,
                },
            },
        }
    return spec


def main() -> None:
    g = gate()
    fake = FakeServer()
    try:
        for task_id, cases in CASES.items():
            task = json.loads((REPO / "tasks" / task_id / "task.json").read_text())
            for case, (steps, client) in cases.items():
                script = f"rag-{task_id}-{case}"
                register(fake, script, steps)
                sim_script = None
                if client is not None:
                    sim_script = f"{script}-client"
                    register(
                        fake,
                        sim_script,
                        [say("(unused: the opening message)")] + [say(t) for t in client],
                    )
                with tempfile.TemporaryDirectory(prefix="rag-fixture-") as tmp:
                    tmp_path = Path(tmp)
                    spec = spec_for(g, fake, tmp_path / "trial", task, case, script, sim_script)
                    run = g.run(tmp_path, fake, spec)
                    assert run.report["label"] == "agent", run.explain()
                    dest = OUT / f"{task_id}-{case}"
                    dest.mkdir(parents=True, exist_ok=True)
                    for f in KEEP:
                        shutil.copy2(run.trial_dir / "out" / f, dest / f)
                    print(
                        dest.relative_to(REPO),
                        run.result.get("end_state"),
                        (run.report.get("checks") or {}).get("unsupported"),
                    )
    finally:
        fake.stop()
    (OUT / "SYNTHETIC.md").write_text(
        "# Synthetic trials, not model output\n\n"
        "Scripted agents on the fake model server, recorded through the own loop by\n"
        "`graders/tests/fixtures/make_rag_fixtures.py` (6 Nov, D79), to prove each retrieval\n"
        "task's graders: `<task>-correct` (finance-rag, searches the documents) must pass and\n"
        "`<task>-made-up` (finance/v3, answers from memory) must fail `no-made-up-figure`.\n"
        "They are not labels and say nothing about how a real model behaves.\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
