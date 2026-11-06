"""draft-mba-loan-missing-info: did the agent ask for the facts it needs, in any form? (DRAFT)

Replaces a regex for a literal "?" (`/\\?/`). On the 4 Nov label batch both answers failed it,
own loop and Hermes alike, although each asked for four missing facts as a numbered list after
"To give you a real answer, I need:" or "To run the numbers, could you share:", with no "?".

Passes when the final answer holds a request and the request names at least two of the facts the
client left out. A request is a sentence with a "?" or a request phrase ("I need", "could you",
"tell me", "let me know", "please share", ...). A request ending in a colon also takes the list
that follows it, and one that points back at a list ("If you share these, ...") takes the list
just before it. Facts mentioned outside a request ("I can't check your income yet") do not
count, and neither does a bare "let me know if you want more".

Destructive review G2 (6 Nov): an offer is not a request. "Let me know if you'd like me to rerun
the EMI for a different interest rate or tenure" asks for nothing, so its offer phrase and its
"?" do not make it one; only a request phrase outside the offer does. And the word "EMI" on its
own is not the existing-debts fact: an answer that works out the new loan's EMI names no other
debt. "Other EMIs", "any EMIs you already pay" and "existing loans" still are.

What it cannot tell: whether the request is clear or polite, or whether an answer that states
its assumptions instead of asking is acceptable. Those are the judge's.
"""

from __future__ import annotations

import re

MIN_TOPICS = 2

# The facts a "should I take this loan" question needs and this client did not give.
TOPICS = {
    "interest rate": r"\binterest rates?\b|\brate of interest\b|\brates?\b|\broi\b",
    "tenure": (
        r"\btenure\b|\brepayment (?:period|term|tenure)\b|\bloan term\b|\bhow long\b"
        r"|\bmoratorium\b"
    ),
    "income or salary": (
        r"\bsalar(?:y|ies)\b|\bincome\b|\btake-?home\b|\bctc\b|\bearn(?:ings?)?\b"
        r"|\bpay package\b"
    ),
    "course cost": (
        r"\bfees?\b|\btuition\b|\bcourse cost\b|\btotal cost\b|\bliving (?:costs|expenses)\b"
    ),
    # Not the bare word "EMI", which is usually the new loan's own EMI (G2).
    "existing debts": (
        r"\b(?:existing|other|current|ongoing|outstanding|any)\s+"
        r"(?:loans?|debts?|emis?|liabilities)\b|\bobligations\b|\byour\s+debts\b"
        r"|\b(?:emis?|loans?|debts?)\s+(?:that\s+)?(?:you\s+)?(?:already\s+)?"
        r"(?:pay|have|carry|service)\b"
    ),
    "savings or support": (
        r"\bsavings\b|\bscholarships?\b|\bsponsor(?:ship)?\b|\bco-?applicant\b|\bcollateral\b"
        r"|\bguarantor\b"
    ),
}
TOPIC_RES = {name: re.compile(pattern, re.IGNORECASE) for name, pattern in TOPICS.items()}

REQUEST = re.compile(
    r"\?"
    r"|\b(?:i|we)(?:'d| would| will|'ll)? need\b"
    r"|\bneed to know\b"
    r"|\btell me\b|\blet me know\b"
    r"|\b(?:could|can|would) you\b"
    r"|\bplease (?:share|send|tell|provide|confirm|give)\b"
    r"|^(?:please )?(?:share|send|tell|give)\b"
    r"|\bif you (?:can )?(?:share|tell|send|give)\b",
    re.IGNORECASE,
)
# An offer to do more ("let me know if you'd like me to", "would you like me to") asks for nothing.
OFFER = re.compile(
    r"\b(?:let me know|tell me|just say|just ask)\s+if\s+you(?:'d|\s+would)?\s+"
    r"(?:like|want|prefer|need)\b"
    r"|\b(?:would|do)\s+you\s+(?:like|want)\s+(?:me\s+to|to\s+see|a|an|the|more)\b"
    r"|\bif\s+you(?:'d|\s+would)?\s+(?:like|want)\s+(?:me\s+to|a|an|the|more)\b"
    r"|\b(?:want|need)\s+me\s+to\b|\bshall\s+i\b|\bhappy\s+to\b",
    re.IGNORECASE,
)
# A request phrase other than a bare "?": what is left of an offer must hold one of these.
PHRASE = re.compile(REQUEST.pattern.removeprefix(r"\?|"), re.IGNORECASE)
# A request that points back at the list before it: "If you share these, ...".
BACK = re.compile(r"\b(?:these|those|them|the above|this information|these details)\b", re.I)
LIST_ITEM = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s+")
SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
MARKUP = re.compile(r"[*_`#>]+")


def _plain(text: str) -> str:
    return MARKUP.sub("", text).strip()


def is_request(sentence: str) -> bool:
    """A "?" or a request phrase; in a sentence that makes an offer, only a request phrase
    outside the offer counts."""
    plain = _plain(sentence)
    if OFFER.search(plain):
        return bool(PHRASE.search(OFFER.sub(" ", plain)))
    return bool(REQUEST.search(plain))


def _list_before(lines: list[str], i: int) -> list[str]:
    """The list items just above line i (blank lines between them skipped), in order."""
    items: list[str] = []
    for line in reversed(lines[:i]):
        if not line.strip():
            continue
        if not LIST_ITEM.match(line):
            break
        items.insert(0, line.strip())
    return items


def requests(answer: str) -> list[str]:
    """Each request in the answer as quoted text (a verbatim piece of the answer), with the list
    that follows a request ending in a colon, or the list before one that points back at it."""
    lines = answer.splitlines()
    found: list[str] = []
    for i, line in enumerate(lines):
        sentences = [s for s in SENTENCE_END.split(line) if s.strip()]
        asking = [s for s in sentences if is_request(s)]
        if not asking:
            continue
        block = [s.strip() for s in asking]
        if _plain(sentences[-1]).endswith(":") and sentences[-1] in asking:
            for follow in lines[i + 1 :]:
                if not follow.strip():
                    continue
                if not LIST_ITEM.match(follow):
                    break
                block.append(follow.strip())
        elif any(BACK.search(_plain(s)) for s in asking):
            block += _list_before(lines, i)
        found.append("\n".join(block))
    return found


def topics_in(text: str) -> list[str]:
    plain = _plain(text)
    return [name for name, pattern in TOPIC_RES.items() if pattern.search(plain)]


def grade(trial: dict) -> dict:
    answer = trial.get("final_answer")
    if not isinstance(answer, str) or not answer.strip():
        return {"verdict": "fail", "reason": "there is no final answer"}
    asked = requests(answer)
    named: dict[str, str] = {}
    for block in asked:
        for topic in topics_in(block):
            named.setdefault(topic, block)
    quotes = list(dict.fromkeys(named.values()))
    evidence = [{"source": "final_answer", "quote": q.splitlines()[0]} for q in quotes]
    if len(named) >= MIN_TOPICS:
        return {
            "verdict": "pass",
            "reason": f"asks for {len(named)} missing facts ({', '.join(named)})",
            "evidence": evidence,
        }
    if not asked:
        return {"verdict": "fail", "reason": "no question or request in the final answer"}
    what = ", ".join(named) or "none of the missing facts"
    need = f"at least {MIN_TOPICS} of: {', '.join(TOPICS)}"
    return {
        "verdict": "fail",
        "reason": f"the answer asks, but names {what}; {need}",
        "evidence": evidence or [{"source": "final_answer", "quote": asked[0].splitlines()[0]}],
    }
