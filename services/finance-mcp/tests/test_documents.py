"""search_documents (D79, 6 Nov): plain keyword search over the document library.

These tests pin the result's shape, its determinism, the edge cases (an empty query, no match, a
large top_k), that the result never echoes the query, that a malformed document fails at
startup, and the library's bytes to its edition (named in the tool description, so in the
finance-rag toolset hash).
"""

import hashlib
import re

import pytest
from finance_mcp import documents
from finance_mcp.server import create_server
from support import call, error, ok, text_of

# The library's bytes at each edition. A change to any document (a figure, a word, a new file)
# changes the digest: then set a new documents.EDITION (which changes the tool description, so
# the finance-rag toolset hash) and pin it here. Do not re-pin an edition a recorded trial used.
PINNED = {
    "2026-11-06": "c3e1e0ba9f4c86a1951517cb31f4f2379628dda95ff54f91789f88ba174e6272",
}
FIELDS = ["doc_id", "title", "date", "section", "passage"]


def library_digest() -> str:
    h = hashlib.sha256()
    for name, text in documents.source_files():
        h.update(name.encode() + b"\0" + text.encode("utf-8") + b"\0")
    return h.hexdigest()


def search(state_dir, **arguments):
    return ok(create_server(state_dir), "search_documents", arguments)


def test_the_library_bytes_are_pinned_to_its_edition() -> None:
    digest = library_digest()
    assert documents.EDITION in PINNED, f"pin edition {documents.EDITION}: {digest}"
    assert digest == PINNED[documents.EDITION], (
        "a document changed: set a new documents.EDITION and pin its digest here"
    )


def test_the_description_names_the_edition(state_dir) -> None:
    import anyio
    from mcp import Client

    async def go():
        async with Client(create_server(state_dir), mode="legacy") as client:
            return {t.name: t for t in (await client.list_tools()).tools}

    tool = anyio.run(go)["search_documents"]
    assert f"edition {documents.EDITION}" in tool.description
    assert "Kaveri Bank's (fictional)" in tool.description


def test_every_document_is_dated_and_names_the_bank_as_fictional() -> None:
    lib = documents.load()
    ids = {p.doc_id for p in lib.passages}
    assert len(ids) == len(documents.source_files()) >= 8
    for p in lib.passages:
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", p.date), p.doc_id
        assert p.date <= "2026-11-06", p.doc_id
        assert p.title.startswith("Kaveri Bank (fictional): "), p.doc_id


def test_a_result_is_passages_with_id_title_date_section_and_text(state_dir) -> None:
    result = search(state_dir, query="fixed deposit rate 2 years")
    assert list(result) == ["results"]
    assert len(result["results"]) == documents.DEFAULT_TOP_K
    for item in result["results"]:
        assert list(item) == FIELDS
    card = [r for r in result["results"] if r["doc_id"] == "kb-deposit-rates"]
    assert card and card[0]["section"].startswith("Fixed deposit (FD) rates by tenure")
    assert card[0]["date"] == "2026-11-01"
    assert "| 2 years to less than 3 years | 6.95% | 7.45% |" in card[0]["passage"]


@pytest.mark.parametrize(
    ("query", "doc_id", "section"),
    [
        ("personal loan foreclosure charge", "kb-prepayment-rules", "Personal loans"),
        ("credit card late payment fee", "kb-charges", "Credit card charges"),
        ("home loan interest rate repo linked", "kb-loan-products", "Home loans"),
        ("close two-wheeler loan early foreclosure", "kb-prepayment-rules", "Two-wheeler"),
        ("break FD early premature withdrawal penalty", "kb-deposit-rules", "Closing"),
        ("processing fee personal loan", "kb-charges", "Loan processing fees"),
        ("personal loan rate CIBIL 785", "kb-loan-products", "Personal loans"),
        ("income tax slabs new regime 2026-27", "kb-bulletin-2026-11", "Income tax slabs"),
        ("RBI repo rate", "kb-bulletin-2026-11", "RBI policy rates"),
    ],
)
def test_the_passage_a_task_needs_is_in_the_top_three(state_dir, query, doc_id, section) -> None:
    results = search(state_dir, query=query)["results"]
    assert any(r["doc_id"] == doc_id and r["section"].startswith(section) for r in results), [
        (r["doc_id"], r["section"]) for r in results
    ]


def test_the_same_query_gives_the_same_bytes(state_dir, tmp_path) -> None:
    args = {"query": "loan rate charges", "top_k": 5}
    first = text_of(call(create_server(state_dir), "search_documents", args))
    again = text_of(call(create_server(tmp_path), "search_documents", args))
    assert first == again
    # In process too, from a freshly built library.
    lib_a, lib_b = documents.load(), documents.load()
    assert lib_a.search("loan rate charges", 5) == lib_b.search("loan rate charges", 5)


def test_ties_keep_the_library_order() -> None:
    lib = documents.Library.build(
        [
            ("a.md", "---\nid: a\ntitle: A\ndate: 2026-11-01\n---\n\n## One\n\nsame words\n"),
            ("b.md", "---\nid: b\ntitle: B\ndate: 2026-11-01\n---\n\n## One\n\nsame words\n"),
        ]
    )
    assert [r["doc_id"] for r in lib.search("same words", 5)["results"]] == ["a", "b"]


@pytest.mark.parametrize("query", ["", "   ", "\n"])
def test_an_empty_query_is_an_error(state_dir, query) -> None:
    message = error(create_server(state_dir), "search_documents", {"query": query})
    assert message == (
        "Error executing tool search_documents: query is empty: give a few words to search for"
    )


def test_a_query_of_only_common_words_is_an_error(state_dir) -> None:
    message = error(create_server(state_dir), "search_documents", {"query": "what is the"})
    assert "query has no words to search for" in message


def test_no_match_returns_no_passages_and_says_so(state_dir) -> None:
    result = search(state_dir, query="cryptocurrency staking yield")
    assert result == {
        "results": [],
        "note": "No passage in the document library matches these words.",
    }


@pytest.mark.parametrize(("top_k", "count"), [(1, 1), (5, 5), (6, 5), (1000, 5)])
def test_top_k_is_capped_at_five(state_dir, top_k, count) -> None:
    results = search(state_dir, query="rate loan deposit fee", top_k=top_k)["results"]
    assert len(results) == count


def test_top_k_below_one_is_refused(state_dir) -> None:
    message = error(create_server(state_dir), "search_documents", {"query": "rate", "top_k": 0})
    assert "invalid arguments" in message


def test_the_result_never_echoes_the_query(state_dir) -> None:
    """A figure the agent puts in its query must not come back as if a document said it, or the
    provenance checks would count it as sourced."""
    text = text_of(
        call(create_server(state_dir), "search_documents", {"query": "FD rate 9.99% zebra"})
    )
    assert "9.99" not in text and "zebra" not in text


@pytest.mark.parametrize(
    ("files", "message"),
    [
        ([("x.md", "no header\n## A\n\ntext\n")], "must start with a --- header"),
        ([("x.md", "---\nid: x\ntitle: X\n---\n\n## A\n\ntext\n")], "exactly id, title, date"),
        ([("x.md", "---\nid: x\ntitle: X\ndate: 2026-13-01\n---\n\n## A\n\nt\n")], "real date"),
        ([("y.md", "---\nid: x\ntitle: X\ndate: 2026-11-01\n---\n\n## A\n\nt\n")], "named after"),
        ([("x.md", "---\nid: x\ntitle: X\ndate: 2026-11-01\n---\n\nno sections\n")], "no '## '"),
        ([("x.md", "---\nid: x\ntitle: X\ndate: 2026-11-01\n---\n\n## A\n\n## B\n\nt\n")], "empty"),
    ],
)
def test_a_malformed_document_is_refused(files, message) -> None:
    with pytest.raises(documents.DocumentsError, match=re.escape(message)):
        documents.Library.build(files)


def test_every_bulletin_figure_section_cites_an_official_https_source() -> None:
    """D79: the bulletin's RBI and tax figures were checked against official sources on 6 Nov;
    each section that gives figures names its source URL on an official domain."""
    lib = documents.load()
    official = (
        "https://www.rbi.org.in/",
        "https://indiabudget.gov.in/",
        "https://www.incometax.gov.in/",
    )
    bulletin = [p for p in lib.passages if p.doc_id == "kb-bulletin-2026-11"]
    with_figures = [p for p in bulletin if re.search(r"\d+(?:\.\d+)?%", p.text)]
    assert [p.section for p in with_figures] == [
        "RBI policy rates",
        "Income tax slabs for individuals, new (default) regime, tax year 2026-27",
    ]
    for p in with_figures:
        urls = re.findall(r"https://\S+", p.text)
        assert urls and all(u.startswith(official) for u in urls), p.section


def test_the_documents_ship_in_the_package() -> None:
    from importlib import resources

    folder = resources.files("finance_mcp").joinpath(documents.DOCUMENTS_DIR)
    assert folder.is_dir()
    assert any(f.name.endswith(".md") for f in folder.iterdir())


def test_stemming_folds_plurals_and_verb_forms() -> None:
    assert documents.tokens("Penalties rates prepaying prepayment fees") == [
        "penalty",
        "rate",
        "prepay",
        "prepay",
        "fee",
    ]
    assert documents.tokens("7.35% for 444 days") == ["7.35", "444", "day"]
