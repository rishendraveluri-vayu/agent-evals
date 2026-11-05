"""draft-convo-job-loss: two checks on the advisor's replies. (DRAFT for Rishi)

`runway_figures`: her question is how long she could keep paying her EMIs and the card without a
salary. An answer needs two figures from her file: the emergency fund (₹60,000, in her profile)
and what her debts cost each month (₹18,332.50 in minimum payments, from list_debts; or its parts:
EMIs ₹14,120 and the card's ₹4,212.50, or ₹10,670, ₹3,450 and ₹4,212.50). Passes when the
advisor's replies, taken together, state both. Amounts are read with the platform's own reader
(evals_graders.amounts), the same one the `number` grader uses, so "₹60,000", "Rs 60000" and
"60,000 rupees" all count; amounts written in words do not.

`care_first`: the system prompt asks for one or two sentences that respond to the person before
the numbers, and for hardship to be acknowledged first. Passes when the first sentence of the
advisor's first reply holds no rupee amount. A proxy: it cannot tell warmth from a cold opening
without numbers, which is the judge's to read.
"""

from __future__ import annotations

import re

from evals_graders.amounts import find

EMERGENCY_FUND = 60000.0
# Each set, all present, is a way of stating her monthly debt payments from the file.
DEBT_PAYMENTS = [
    (18332.5,),
    (14120.0, 4212.5),
    (10670.0, 3450.0, 4212.5),
]
TOLERANCE = 1.0
SENTENCE_END = re.compile(r"(?<=[.!?])\s+|\n+")
MARKUP = re.compile(r"[*_`#>]+")


def _amounts(messages: list[str]) -> list[tuple[float, str]]:
    out = []
    for text in messages:
        for f in find(text, "amount"):
            out.append((f.value, f.text))
    return out


def _has(amounts: list[tuple[float, str]], value: float) -> str | None:
    for found, text in amounts:
        if abs(found - value) <= TOLERANCE:
            return text
    return None


def runway_figures(trial: dict) -> dict:
    messages = [m for m in trial.get("agent_messages") or [] if isinstance(m, str)]
    if not messages:
        return {"verdict": "fail", "reason": "the advisor wrote no reply"}
    amounts = _amounts(messages)
    fund = _has(amounts, EMERGENCY_FUND)
    debts = None
    for option in DEBT_PAYMENTS:
        quotes = [_has(amounts, v) for v in option]
        if all(quotes):
            debts = [q for q in quotes if q]
            break
    evidence = [
        {"source": "agent_message", "quote": q} for q in ([fund] if fund else []) + (debts or [])
    ]
    missing = []
    if not fund:
        missing.append("the ₹60,000 emergency fund")
    if not debts:
        missing.append("her monthly debt payments (₹18,332.50, or its parts)")
    if missing:
        return {
            "verdict": "fail",
            "reason": "the replies never state " + " or ".join(missing),
            "evidence": evidence,
        }
    payments = ", ".join(debts)
    return {
        "verdict": "pass",
        "reason": f"states the emergency fund ({fund}) and the monthly debt payments ({payments})",
        "evidence": evidence,
    }


def care_first(trial: dict) -> dict:
    messages = [m for m in trial.get("agent_messages") or [] if isinstance(m, str) and m.strip()]
    if not messages:
        return {"verdict": "fail", "reason": "the advisor wrote no reply"}
    first = next(s for s in SENTENCE_END.split(messages[0].strip()) if s.strip())
    found = find(MARKUP.sub("", first), "amount")
    if found:
        return {
            "verdict": "fail",
            "reason": f"the first reply opens with an amount ({found[0].text}), not with her",
            "evidence": [{"source": "agent_message", "quote": first.strip()}],
        }
    return {
        "verdict": "pass",
        "reason": "the first sentence of the first reply has no amount",
        "evidence": [{"source": "agent_message", "quote": first.strip()}],
    }
