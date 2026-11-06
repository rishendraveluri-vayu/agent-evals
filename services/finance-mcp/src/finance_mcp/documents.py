"""The `search_documents` tool (D79, 6 Nov): plain keyword search over a small, dated document
library, for the retrieval experiment (toolset `finance-rag/v1`).

The library is the markdown files in `documents/` next to this module: Kaveri Bank's (fictional)
current rate card, loan sheet, prepayment rules, schedule of charges, card terms, savings rates and
FAQ, and a dated rates and rules bulletin whose tax and RBI figures cite their official sources.
Every file starts with a header block:

    ---
    id: kb-deposit-rates
    title: Kaveri Bank (fictional): deposit rate card, fixed and recurring deposits
    date: 2026-11-01
    ---

and each `## ` section is one passage (its heading and body). The search is Okapi BM25 over
lower-cased word tokens with a light suffix strip (rates -> rate, prepayment -> prepay), and a
small stop-word list, in exact Decimal arithmetic, so the same query always gives the same
passages in the same order on any machine: no embeddings, no model, no clock, no network. Ties
keep the library's order (file name, then section).

What the agent is shown per passage: `doc_id`, `title`, `date`, `section` and `passage`. No score
and no echo of the query, so the result's only numbers are the documents' own (and dates), and a
figure the agent puts in its query never comes back as if a document said it.

The library's edition (EDITION) is named in the tool's description, which the toolset hash
covers, and a test pins the documents' bytes to it: a changed document is a new edition, so a new
description and a new toolset hash, never an edit in place.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, localcontext
from importlib import resources
from typing import Any

DOCUMENTS_DIR = "documents"
# The library's edition, named in the tool description. Change it with any document.
EDITION = "2026-11-06"
DEFAULT_TOP_K = 3
MAX_TOP_K = 5
# Okapi BM25's usual constants.
K1 = Decimal("1.2")
B = Decimal("0.75")
HEADER = re.compile(r"\A---\n(?P<body>.*?)\n---\n", re.DOTALL)
FIELDS = ("id", "title", "date")
TOKEN = re.compile(r"[a-z0-9]+(?:\.[0-9]+)?")
STOP_WORDS = frozenset(
    {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "by",
        "can",
        "do",
        "does",
        "for",
        "from",
        "has",
        "have",
        "how",
        "i",
        "if",
        "in",
        "is",
        "it",
        "its",
        "me",
        "my",
        "of",
        "on",
        "or",
        "our",
        "so",
        "than",
        "that",
        "the",
        "their",
        "them",
        "then",
        "there",
        "this",
        "to",
        "was",
        "we",
        "what",
        "when",
        "where",
        "which",
        "who",
        "will",
        "with",
        "would",
        "you",
        "your",
    }
)


class DocumentsError(Exception):
    """A document file is malformed. The message names the file and the problem."""


class SearchError(ValueError):
    """The query cannot be searched (empty, or only stop words)."""


@dataclass(frozen=True)
class Passage:
    doc_id: str
    title: str
    date: str
    section: str
    text: str
    tokens: tuple[str, ...]


def stem(word: str) -> str:
    """A light suffix strip, enough for plurals and the common verb forms: penalties -> penalty,
    rates -> rate, prepaying and prepayment -> prepay, closed -> clos. Not a full stemmer."""
    if len(word) > 4 and word.endswith("ies"):
        word = word[:-3] + "y"
    elif len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        word = word[:-1]
    if len(word) > 5 and word.endswith("ing"):
        word = word[:-3]
    elif len(word) > 6 and word.endswith("ment"):
        word = word[:-4]
    elif len(word) > 4 and word.endswith("ed"):
        word = word[:-2]
    return word


def tokens(text: str) -> list[str]:
    """Searchable words: lower case, letters and digits (7.35 stays one token), no stop words."""
    return [stem(t) for t in TOKEN.findall(text.lower()) if t not in STOP_WORDS]


def _parse(name: str, text: str) -> list[Passage]:
    m = HEADER.match(text)
    if not m:
        raise DocumentsError(f"{name}: must start with a --- header block")
    header: dict[str, str] = {}
    for line in m.group("body").splitlines():
        key, sep, value = line.partition(":")
        if not sep or not value.strip():
            raise DocumentsError(f"{name}: header line {line!r} is not 'key: value'")
        header[key.strip()] = value.strip()
    if set(header) != set(FIELDS):
        raise DocumentsError(f"{name}: the header must hold exactly {', '.join(FIELDS)}")
    try:
        date.fromisoformat(header["date"])
    except ValueError:
        raise DocumentsError(f"{name}: date must be a real date, YYYY-MM-DD") from None
    if f"{header['id']}.md" != name:
        raise DocumentsError(f"{name}: the file must be named after its id, {header['id']}.md")
    body = text[m.end() :]
    sections = re.split(r"^## ", body, flags=re.MULTILINE)
    passages = []
    for chunk in sections[1:]:
        heading, _, rest = chunk.partition("\n")
        passage = f"{heading.strip()}\n{rest.strip()}".strip()
        if not rest.strip():
            raise DocumentsError(f"{name}: section {heading.strip()!r} is empty")
        passages.append(
            Passage(
                doc_id=header["id"],
                title=header["title"],
                date=header["date"],
                section=heading.strip(),
                text=passage,
                tokens=tuple(tokens(passage)),
            )
        )
    if not passages:
        raise DocumentsError(f"{name}: has no '## ' section")
    return passages


def source_files() -> list[tuple[str, str]]:
    """(file name, text) for every document, in file-name order."""
    folder = resources.files("finance_mcp").joinpath(DOCUMENTS_DIR)
    files = sorted(
        (f.name, f.read_text(encoding="utf-8")) for f in folder.iterdir() if f.name.endswith(".md")
    )
    if not files:
        raise DocumentsError(f"no documents in {DOCUMENTS_DIR}/")
    return files


@dataclass(frozen=True)
class Library:
    passages: tuple[Passage, ...]
    idf: dict[str, Decimal]
    avg_len: Decimal

    @classmethod
    def build(cls, files: list[tuple[str, str]]) -> Library:
        passages: list[Passage] = []
        seen: set[str] = set()
        for name, text in files:
            parsed = _parse(name, text)
            if parsed[0].doc_id in seen:
                raise DocumentsError(f"{name}: duplicate id {parsed[0].doc_id}")
            seen.add(parsed[0].doc_id)
            passages.extend(parsed)
        n = Decimal(len(passages))
        df: dict[str, int] = {}
        for p in passages:
            for t in set(p.tokens):
                df[t] = df.get(t, 0) + 1
        with localcontext() as ctx:
            ctx.prec = 28
            half = Decimal("0.5")
            idf = {t: ((n - c + half) / (c + half) + 1).ln() for t, c in df.items()}
            avg = Decimal(sum(len(p.tokens) for p in passages)) / n
        return cls(tuple(passages), idf, avg)

    def _score(self, passage: Passage, query: list[str]) -> Decimal:
        with localcontext() as ctx:
            ctx.prec = 28
            length = Decimal(len(passage.tokens))
            total = Decimal(0)
            for term in dict.fromkeys(query):  # each query word once, in order
                tf = passage.tokens.count(term)
                if not tf:
                    continue
                tf_d = Decimal(tf)
                norm = K1 * (1 - B + B * length / self.avg_len)
                total += self.idf[term] * tf_d * (K1 + 1) / (tf_d + norm)
            return total

    def search(self, query: str, top_k: int = DEFAULT_TOP_K) -> dict[str, Any]:
        """The tool's result: up to min(top_k, MAX_TOP_K) passages that share a word with the
        query, best first. An empty query (or one of stop words only) is a SearchError."""
        if not query.strip():
            raise SearchError("query is empty: give a few words to search for")
        words = tokens(query)
        if not words:
            raise SearchError("query has no words to search for (only common words like 'the')")
        k = max(1, min(int(top_k), MAX_TOP_K))
        scored = [
            (score, i) for i, p in enumerate(self.passages) if (score := self._score(p, words)) > 0
        ]
        scored.sort(key=lambda s: (-s[0], s[1]))
        results = [
            {
                "doc_id": p.doc_id,
                "title": p.title,
                "date": p.date,
                "section": p.section,
                "passage": p.text,
            }
            for p in (self.passages[i] for _, i in scored[:k])
        ]
        out: dict[str, Any] = {"results": results}
        if not results:
            out["note"] = "No passage in the document library matches these words."
        return out


def load() -> Library:
    """The library, read from the installed package and checked, so a malformed document fails
    when the server starts, not in a trial."""
    return Library.build(source_files())
