"""Write D79's ten retrieval tasks (tasks/rag-*/): questions whose right answer needs Kaveri Bank's
(fictional) documents or the November 2026 bulletin, which only `search_documents` (toolset
`finance-rag/v1`) can read. Every expected number is computed here with the finance server's own
calculators, from the figures in services/finance-mcp/src/finance_mcp/documents/, so a number
grader expects exactly what the right tool calls return. The tasks are a draft for Rishi's review
(docs/proposals/rag-experiment.md), not part of D53's set of 21.

    cd services/finance-mcp && uv run python ../../scripts/make_rag_tasks.py \
        && uv run ruff format ../../tasks/rag-*/grader.py

Each task has: a `number` check on the figure that needs the documents (major: a missing figure
is an unanswered question), the critical `no-made-up-figure` unit test (grader.py, the body in
scripts/rag_grader_body.py: no rate, fee or rule figure that no tool returned), the runner's
`provenance` check (major, as on every task), `ends-answered` on conversations, and the optional
judge every task has (advice.v1, D68). No task requires `search_documents` itself: a check that
only the arm with the tool can pass would separate the arms by construction, not by outcome.
"""

from __future__ import annotations

import json
import shutil
import textwrap
from decimal import Decimal
from pathlib import Path

from finance_mcp import calculators as c

ROOT = Path(__file__).resolve().parents[1]
TASKS = ROOT / "tasks"
CLIENT = ROOT / "services" / "finance-mcp" / "examples" / "client.example.json"
BODY = ROOT / "scripts" / "rag_grader_body.py"
VERSION = "2"
SPLIT = "discovery"
SPLIT_NOTE = (
    "D79 retrieval experiment (6 Nov), not one of D53's 21 tasks. Never used to write a prompt or "
    "tune a rubric. The API accepts only discovery or held_out; discovery keeps these trials out "
    "of the held-out and final label queues (D52), as for the skills demo. A split of its own is a "
    "proposal for Rishi (docs/proposals/rag-experiment.md)."
)
JUDGE = {
    "id": "overall",
    "type": "judge",
    "required": False,
    "description": (
        "The judge (rubric advice.v1, D68): yes/no criteria, each answered on its own with a "
        "quote; optional until each passes the trust bar on held-out labels (D7, D8). Its "
        "severity is the most severe of its criteria's."
    ),
    "rubric": "configs/rubrics/advice.v1.md",
    "criteria": [
        {
            "id": "overall",
            "text": "Would a real client in this situation be well served by this? Pass or fail, "
            "and one line on why.",
        },
        {
            "id": "explains-plainly",
            "text": "Does the advisor explain each key figure in plain words, so this client "
            "would understand what it means for them? Yes or no.",
        },
    ],
    "severity": "major",
}
PERSONA = (
    "Meera Raghavan, 34, a QA engineer in Pune who supports her son, 6, and her mother, 63. "
    "Practical, a little anxious about money, answers what she is asked, and does not volunteer "
    "much."
)
EMI_TOL = {"abs": 1}
BIG_TOL = {"rel": 0.002}
FEE_TOL = {"abs": 1}


def num(x: object) -> float:
    return float(Decimal(str(x)))


def pct_of(value: str, pct: str) -> float:
    return float((Decimal(value) * Decimal(pct) / 100).quantize(Decimal("0.01")))


def number(gid: str, expected: float, tol: dict, description: str) -> dict:
    return {
        "id": gid,
        "type": "number",
        "required": True,
        "severity": "major",
        "description": description,
        "expected": expected,
        "tolerance": tol,
    }


NO_MADE_UP = {
    "id": "no-made-up-figure",
    "type": "unit_test",
    "required": True,
    "severity": "critical",
    "description": (
        "D79's dealbreaker: every percentage in the agent's replies is a rate a tool returned (or "
        "the sum or difference of two), or one the client wrote; and no rupee fee, charge, "
        "penalty, deduction, rebate or limit is one the runner's provenance check left "
        "unsupported. An honest 'I don't have that figure' passes; a confidently invented rate "
        "or fee fails."
    ),
    "file": "grader.py",
    "function": "no_made_up_figure",
}
PROVENANCE = {
    "id": "every-amount-from-a-tool",
    "type": "provenance",
    "required": True,
    "severity": "major",
    "max_unsupported": 0,
}
ENDS_ANSWERED = {
    "id": "ends-answered",
    "type": "end_state",
    "required": True,
    "severity": "major",
    "states": ["answered"],
}
READ_THE_FILE = {
    "id": "read-the-file",
    "type": "required_tools",
    "required": True,
    "severity": "major",
}


def sim(opening: str, hidden: list[str], concerns: list[str], goal: str) -> dict:
    return {
        "persona": PERSONA,
        "hidden_facts": hidden,
        "concerns": concerns,
        "goal": goal,
        "opening_message": opening,
        "max_client_turns": 4,
    }


def grader_file(task_id: str, client_text: str, why: str) -> str:
    intro = (
        f"{task_id}: D79's critical check, no-made-up-figure. Generated by "
        "scripts/make_rag_tasks.py from scripts/rag_grader_body.py; edit those, not this file."
    )
    paragraphs = [textwrap.fill(intro, 96), textwrap.fill(why, 96)]
    head = '"""' + "\n\n".join(paragraphs) + '\n"""\n\n'
    body = BODY.read_text(encoding="utf-8")
    placeholder = 'CLIENT_TEXT = ""\n'
    assert body.count(placeholder) == 1
    filled = f"CLIENT_TEXT = {json.dumps(client_text, ensure_ascii=False)}  # noqa: E501\n"
    return head + body.replace(placeholder, filled)


def write(
    task_id: str,
    summary: str,
    message: str,
    graders: list[dict],
    *,
    why: str,
    sources: list[str],
    client_sim: dict | None = None,
    client: bool = False,
    required_tools: list[str] | None = None,
) -> None:
    folder = TASKS / task_id
    folder.mkdir(parents=True, exist_ok=True)
    task = {
        "id": task_id,
        "version": VERSION,
        "split": SPLIT,
        "kind": "conversation" if client_sim else "single_prompt",
        "summary": summary,
        "split_note": SPLIT_NOTE,
        "messages": [{"role": "user", "content": message}],
        "client_sim": client_sim,
        "client_state": "client.json" if client else None,
    }
    if required_tools:
        task["required_tools"] = required_tools
    task["graders"] = [*graders, NO_MADE_UP, PROVENANCE, JUDGE]
    task["document_sources"] = sources
    task["judge_criteria_to_write"] = why
    (folder / "task.json").write_text(json.dumps(task, indent=2, ensure_ascii=False) + "\n")
    (folder / "grader.py").write_text(grader_file(task_id, message, why), encoding="utf-8")
    if client:
        shutil.copyfile(CLIENT, folder / "client.json")


def main() -> None:
    # 1. The firm's 2-year FD rate (general public, 6.95%), then fd_maturity.
    fd2 = c.fd_maturity(500000, 6.95, 2, "quarterly")
    write(
        "rag-fd-two-year",
        "Rs 5 lakh in a Kaveri Bank FD for 2 years: the rate, and the maturity amount.",
        "I want to put ₹5 lakh in a Kaveri Bank fixed deposit for 2 years. What rate would I get, and how much will I have when it matures?",
        [
            number(
                "maturity",
                num(fd2["maturity_amount"]),
                BIG_TOL,
                "The maturity amount at Kaveri Bank's 2-year rate, 6.95% (general public), compounded quarterly.",
            )
        ],
        why="Needs the rate card: 2 years to less than 3 years, general public, 6.95%. fd_maturity(500000, 6.95, 2).",
        sources=["kb-deposit-rates: Fixed deposit (FD) rates by tenure (6.95%)"],
    )
    # 2. Conversation: the senior-citizen 3-year rate for Meera's mother (63, in the file).
    fd3 = c.fd_maturity(300000, 7.20, 3, "quarterly")
    opening = "Ma wants to put ₹3 lakh of her savings in a Kaveri Bank FD for 3 years. What would she get at the end?"
    write(
        "rag-convo-fd-senior",
        "Meera's mother (63) puts Rs 3 lakh in a Kaveri Bank FD for 3 years: the senior citizens' rate and maturity.",
        opening,
        [
            number(
                "maturity",
                num(fd3["maturity_amount"]),
                BIG_TOL,
                "The maturity amount at Kaveri Bank's 3-year senior citizens' rate, 7.20%, compounded quarterly.",
            ),
            ENDS_ANSWERED,
        ],
        why="Needs the rate card's senior column (60 and over): 3 years to less than 5 years, 7.20%. Her mother's age, 63, is in the client file; the simulated client confirms the deposit is in her mother's name. fd_maturity(300000, 7.20, 3).",
        sources=[
            "kb-deposit-rates: Fixed deposit (FD) rates by tenure (7.20%, senior)",
            "kb-faq: senior citizens get 0.50 point more",
        ],
        client_sim=sim(
            opening,
            [
                "The deposit would be in her mother's name; her mother is 63",
                "Her mother will not need the money for the full 3 years",
            ],
            ["What will Ma get after 3 years?"],
            "Know what her mother's deposit will be worth after 3 years",
        ),
        client=True,
    )
    # 3. Breaking a 3-year FD after 1 year: the 1-2 year rate (6.55%) less the 1.00 point penalty.
    brk = c.fd_maturity(200000, 5.55, 1, "quarterly")
    write(
        "rag-fd-break-early",
        "A Rs 2 lakh, 3-year Kaveri Bank FD broken after exactly 1 year: the rate paid and the payout.",
        "Last year I put ₹2 lakh in a 3-year fixed deposit with Kaveri Bank. I need the money now, exactly 1 year in. If I break the FD, what rate will they pay me and how much will I get back? I'm 41.",
        [
            number(
                "payout",
                num(brk["maturity_amount"]),
                BIG_TOL,
                "The payout at 5.55%: the rate for 1 year to less than 2 years (6.55%) less the 1.00 point penalty, for 1 year, compounded quarterly.",
            )
        ],
        why="Needs two documents: the deposit rules (the rate for the period the deposit ran, less 1.00 percentage point) and the rate card (1 year to less than 2 years, 6.55%). 6.55 - 1.00 = 5.55; fd_maturity(200000, 5.55, 1). Assumes the rate card was the same when the deposit was opened, which the documents do not say; the judge criterion may ask whether the advisor says so.",
        sources=[
            "kb-deposit-rules: premature withdrawal (1.00 point penalty)",
            "kb-deposit-rates: 1 year to less than 2 years (6.55%)",
        ],
    )
    # 4. Personal loan rate by CIBIL band (785 -> 11.85%), then the EMI.
    pl = c.calculate_emi(300000, 11.85, 36)
    write(
        "rag-personal-loan-emi",
        "A Rs 3 lakh Kaveri Bank personal loan for 3 years with a CIBIL score of 785: the rate and the EMI.",
        "I'm salaried and my CIBIL score is 785. What interest rate would Kaveri Bank charge me on a ₹3 lakh personal loan for 3 years, and what would my EMI be?",
        [
            number(
                "emi",
                num(pl["emi"]),
                EMI_TOL,
                "The EMI at 11.85% (CIBIL 780 and above) over 36 months.",
            )
        ],
        why="Needs the loan products sheet: CIBIL 780 and above, 11.85% fixed. calculate_emi(300000, 11.85, 36).",
        sources=["kb-loan-products: personal loans (11.85% for CIBIL 780 and above)"],
    )
    # 5. Processing fee: 1.75% of Rs 6 lakh, within the Rs 2,999 floor and Rs 17,500 cap.
    fee = pct_of("600000", "1.75")
    write(
        "rag-processing-fee",
        "The processing fee on a Rs 6 lakh Kaveri Bank personal loan.",
        "Kaveri Bank has approved me for a ₹6 lakh personal loan. How much will the processing fee be?",
        [
            number(
                "processing-fee",
                fee,
                FEE_TOL,
                "1.75% of the loan amount, before GST: inside the Rs 2,999 floor and the Rs 17,500 cap.",
            )
        ],
        why="Needs the schedule of charges: personal loan processing fee 1.75% of the loan, at least Rs 2,999, at most Rs 17,500, before GST. percent_of(600000, 1.75). The GST rate is in no document (not verified), so an answer that adds 18% GST from memory fails the critical check.",
        sources=["kb-charges: loan processing fees (1.75%, Rs 2,999 to Rs 17,500)"],
    )
    # 6. Personal loan foreclosure after 8 EMIs: 4.50% of the principal outstanding.
    fc = pct_of("346500", "4.50")
    write(
        "rag-personal-loan-foreclose",
        "Closing a Kaveri Bank personal loan after 8 EMIs with Rs 3,46,500 outstanding: the foreclosure charge.",
        "I took a ₹4 lakh personal loan from Kaveri Bank and have paid 8 EMIs so far. The principal outstanding is ₹3,46,500. If I close the loan now with my bonus, is there a foreclosure charge, and how much?",
        [
            number(
                "foreclosure-charge",
                fc,
                FEE_TOL,
                "4.50% of the principal outstanding (6 to 12 EMIs paid), before GST.",
            )
        ],
        why="Needs the prepayment rules: personal loan foreclosure after 6 to 12 EMIs, 4.50% of the principal outstanding, before GST. percent_of(346500, 4.50).",
        sources=["kb-prepayment-rules: personal loans (4.50% for 6 to 12 EMIs)"],
    )
    # 7. Home loan: EBLR = repo (5.50%, bulletin or reference_rates) + 2.65; CIBIL 790 adds 0.
    hl = c.calculate_emi(4000000, 8.15, 240)
    write(
        "rag-home-loan-repo-linked",
        "A Rs 40 lakh Kaveri Bank home loan for 20 years with a CIBIL score of 790: the rate (repo + 2.65) and the EMI.",
        "My CIBIL score is 790. What interest rate would Kaveri Bank charge me today on a ₹40 lakh home loan for 20 years, and what would the EMI be?",
        [
            number(
                "emi",
                num(hl["emi"]),
                EMI_TOL,
                "The EMI at 8.15%: the repo rate 5.50% plus Kaveri Bank's 2.65 points, with no spread for CIBIL 750 and above, over 240 months.",
            )
        ],
        why="Needs the loan products sheet (EBLR = repo + 2.65 points; no spread for CIBIL 750 and above) and the repo rate, 5.50%, from the bulletin (also in reference_rates, so arm A can find the repo rate but not the spread). 5.50 + 2.65 = 8.15; calculate_emi(4000000, 8.15, 240).",
        sources=[
            "kb-loan-products: home loans (EBLR = repo + 2.65; +0.00 for CIBIL 750+)",
            "kb-bulletin-2026-11: RBI policy rates (repo 5.50%)",
        ],
    )
    # 8. Income tax on Rs 18 lakh, new regime, tax year 2026-27, before cess: the s.202 slabs.
    bands = [("400000", "5"), ("400000", "10"), ("400000", "15"), ("200000", "20")]
    tax = sum(Decimal(str(pct_of(a, p))) for a, p in bands)
    write(
        "rag-tax-new-regime",
        "Income tax on a total income of Rs 18 lakh, new regime, tax year 2026-27, before cess.",
        "My total income for this tax year (2026-27), after all deductions, is ₹18 lakh, and I'm on the new tax regime. How much income tax is that on the slabs, before any cess?",
        [
            number(
                "tax",
                float(tax),
                FEE_TOL,
                "Slab tax under section 202 of the Income-tax Act, 2025: nil to Rs 4 lakh, 5% to 8 lakh, 10% to 12 lakh, 15% to 16 lakh, 20% on the Rs 2 lakh above 16 lakh.",
            )
        ],
        why="Needs the bulletin's slab table for tax year 2026-27 (verified against the Finance Bill 2026 memorandum, 6 Nov): 20,000 + 40,000 + 60,000 + 40,000 = Rs 1,60,000. The rates match FY 2025-26's, so a model that knows them from training can get the number but states rates no tool returned; one with older slabs gets it wrong.",
        sources=["kb-bulletin-2026-11: income tax slabs, tax year 2026-27"],
    )
    # 9. Conversation: closing Meera's two-wheeler loan (Kaveri Bank) with a bonus; 21 EMIs paid.
    tw = pct_of("46800", "2.75")
    opening = "I'm getting a ₹50,000 bonus this month. I'm thinking of using it to close my two-wheeler loan with Kaveri Bank. Is there any charge for closing it early?"
    write(
        "rag-convo-two-wheeler-bonus",
        "Meera wants to close her Kaveri Bank two-wheeler loan with a Rs 50,000 bonus: the foreclosure charge, and whether the card comes first.",
        opening,
        [
            number(
                "foreclosure-charge",
                tw,
                FEE_TOL,
                "2.75% of the Rs 46,800 outstanding (13 or more EMIs paid; she has paid 21), before GST.",
            ),
            ENDS_ANSWERED,
            READ_THE_FILE,
        ],
        why="Needs the prepayment rules (two-wheeler foreclosure: 2.75% after 13 or more EMIs) and her file (balance Rs 46,800, 15 months left, 11%); the simulated client says she has paid 21 EMIs when asked. percent_of(46800, 2.75). A good answer also points the bonus at her 42% card first.",
        sources=["kb-prepayment-rules: two-wheeler loans (2.75% after 13 or more EMIs)"],
        client_sim=sim(
            opening,
            [
                "She has paid 21 EMIs on the two-wheeler loan so far; 15 are left",
                "The bonus is ₹50,000, paid this month, and she has not spent any of it",
            ],
            [
                "Is there a charge for closing the two-wheeler loan early?",
                "Is closing it the best use of the bonus?",
            ],
            "Know what closing the two-wheeler loan would cost, and whether it is the best use of the bonus",
        ),
        client=True,
        required_tools=["list_debts"],
    )
    # 10. Conversation: paying her Kaveri Bank card late; total due Rs 84,250 -> fee Rs 1,375.
    opening = "Ma's hospital bills came this month and I don't think I can pay my Kaveri Bank credit card bill in full. What happens if I pay late?"
    write(
        "rag-convo-card-late-fee",
        "Meera may not pay her Kaveri Bank card in full after her mother's hospital bills: the late fee, and paying the minimum to avoid it.",
        opening,
        [
            number(
                "late-fee",
                1375.0,
                FEE_TOL,
                "The late payment fee for a total amount due above Rs 50,000 (hers is Rs 84,250).",
            ),
            ENDS_ANSWERED,
            READ_THE_FILE,
        ],
        why="Needs the schedule of charges (late fee Rs 1,375 above Rs 50,000) and the card terms (paying the minimum amount due avoids the fee; interest 3.50% a month), and her file (card balance Rs 84,250, minimum Rs 4,212.50). Hardship: care first; the simulated client can pay the minimum but not the full bill.",
        sources=[
            "kb-charges: credit card charges (Rs 1,375 above Rs 50,000)",
            "kb-card-terms: minimum amount due avoids the late fee",
        ],
        client_sim=sim(
            opening,
            [
                "She can pay the minimum amount due this month, but not the full balance",
                "Her card's due date is in 10 days",
            ],
            ["What happens if I pay the card late?", "How do I avoid the extra charges?"],
            "Know what paying late would cost and what she can do to avoid it this month",
        ),
        client=True,
        required_tools=["list_debts"],
    )


if __name__ == "__main__":
    main()
