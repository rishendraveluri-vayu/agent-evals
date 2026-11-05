"""MCP-level tests with the mcp 2.3.0 client: in-process, stdio (subprocess) and streamable HTTP
(subprocess), plus the tools-manifest snapshot. The mcp 1.30.0 client is in test_compat_mcp1.py.

The 2.3.0 client is exercised three ways:
- `Client(mode="legacy")`: the initialize handshake;
- `Client(mode="auto")`: server/discover, which settles on the stateless 2026-07-28 protocol;
- `ClientSession(read, write)` + `initialize()` on raw transports, which is how Hermes connects.
"""

import importlib.metadata
import json
import os
import urllib.request
from pathlib import Path
from typing import Any

import pytest
from finance_mcp.server import create_server
from mcp import Client, ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamable_http_client
from support import (
    ARITHMETIC,
    EXPECTED_TOOLS,
    SAMPLE_CALLS,
    SNAPSHOT,
    call,
    error,
    ok,
    stdio_command,
    text_of,
)

pytestmark = pytest.mark.anyio

HANDSHAKE_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]
MODERN_VERSION = "2026-07-28"


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def manifest_entry(tool: Any) -> dict[str, Any]:
    return tool.model_dump(mode="json", by_alias=True, exclude_none=True)


async def exercise(client: Client) -> tuple[str, list[str], list[str]]:
    tools = await client.list_tools()
    texts = []
    for name, arguments in SAMPLE_CALLS:
        result = await client.call_tool(name, arguments)
        assert not result.is_error, text_of(result)
        texts.append(text_of(result))
    return client.protocol_version, [t.name for t in tools.tools], texts


async def in_process_texts(state_dir: Path) -> list[str]:
    async with Client(create_server(state_dir), mode="legacy") as client:
        return (await exercise(client))[2]


# --- manifest -----------------------------------------------------------------------------------


def test_client_under_test_is_mcp_2_3_0() -> None:
    assert importlib.metadata.version("mcp") == "2.3.0"


async def test_list_tools_returns_exactly_the_expected_tools(state_dir: Path) -> None:
    """Eleven finance tools, then the seven arithmetic tools added on 5 Nov (D54), then
    reference_rates (D58)."""
    async with Client(create_server(state_dir), mode="legacy") as client:
        tools = (await client.list_tools()).tools
    assert [t.name for t in tools] == EXPECTED_TOOLS
    assert all(t.output_schema is None for t in tools)
    assert all(t.annotations.read_only_hint is True for t in tools)


async def test_tools_manifest_snapshot(state_dir: Path) -> None:
    """Everything an agent sees about the tools. A failure here is a visible change to every
    harness: regenerate with FINANCE_MCP_UPDATE_SNAPSHOT=1 and review the diff."""
    async with Client(create_server(state_dir), mode="legacy") as client:
        tools = (await client.list_tools()).tools
    text = json.dumps([manifest_entry(t) for t in tools], indent=2, ensure_ascii=False) + "\n"
    if os.environ.get("FINANCE_MCP_UPDATE_SNAPSHOT") == "1":
        SNAPSHOT.write_text(text, encoding="utf-8")
    assert SNAPSHOT.read_text(encoding="utf-8") == text


async def test_both_protocol_eras_send_the_same_manifest(state_dir: Path) -> None:
    """Same content in both eras. Only the root inputSchema key order differs, and that is the
    SDK's per-era wire model: 2025-11-25 writes properties, required, type first; 2026-07-28
    writes type first. The server emits the 2025-11-25 order, which every known harness uses."""
    manifests = {}
    for mode in ("legacy", "auto"):
        async with Client(create_server(state_dir), mode=mode) as client:
            manifests[mode] = [manifest_entry(t) for t in (await client.list_tools()).tools]
    assert manifests["legacy"] == manifests["auto"]
    for legacy, modern in zip(manifests["legacy"], manifests["auto"], strict=True):
        assert list(legacy["inputSchema"]) == [
            "properties",
            "required",
            "type",
            "additionalProperties",
        ]
        assert list(modern["inputSchema"]) == [
            "type",
            "properties",
            "required",
            "additionalProperties",
        ]
        strip = {k: v for k, v in legacy.items() if k != "inputSchema"}
        assert json.dumps(strip, ensure_ascii=False) == json.dumps(
            {k: v for k, v in modern.items() if k != "inputSchema"}, ensure_ascii=False
        )
        for name in legacy["inputSchema"]["properties"]:
            assert json.dumps(legacy["inputSchema"]["properties"][name]) == json.dumps(
                modern["inputSchema"]["properties"][name]
            )


def _walk_schema(node: dict[str, Any], path: str, problems: list[str]) -> None:
    for banned in ("$ref", "$defs", "definitions", "title", "anyOf", "oneOf", "allOf"):
        if banned in node:
            problems.append(f"{path}: has {banned}")
    if "type" not in node:
        problems.append(f"{path}: no type")
    if node.get("type") == "object":
        for key in ("properties", "required"):
            if key not in node:
                problems.append(f"{path}: object without {key}")
        if node.get("additionalProperties") is not False:
            problems.append(f"{path}: object without additionalProperties: false")
        if set(node.get("required", [])) - set(node.get("properties", {})):
            problems.append(f"{path}: required names an undeclared property")
    if node.get("type") == "array" and "items" not in node:
        problems.append(f"{path}: array without items")
    if "description" in node and not isinstance(node["description"], str):
        problems.append(f"{path}: description is not a string")
    for name, sub in node.get("properties", {}).items():
        if "description" not in sub:
            problems.append(f"{path}.{name}: no description")
        _walk_schema(sub, f"{path}.{name}", problems)
    if "items" in node:
        _walk_schema(node["items"], f"{path}[]", problems)


def test_snapshot_input_schemas_are_flat_and_self_contained() -> None:
    manifest = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    assert [t["name"] for t in manifest] == EXPECTED_TOOLS
    raw = SNAPSHOT.read_text(encoding="utf-8")
    for token in ('"$ref"', '"$defs"', '"title"', '"anyOf"'):
        assert token not in raw
    problems: list[str] = []
    for tool in manifest:
        assert set(tool) == {"name", "description", "inputSchema", "annotations"}, tool["name"]
        _walk_schema(tool["inputSchema"], tool["name"], problems)
        sentences = [s for s in tool["description"].split(". ") if s]
        assert 1 <= len(sentences) <= 3, tool["name"]
    assert problems == []


def test_nested_debt_objects_are_inlined() -> None:
    manifest = {t["name"]: t for t in json.loads(SNAPSHOT.read_text(encoding="utf-8"))}
    items = manifest["debt_payoff_plan"]["inputSchema"]["properties"]["debts"]["items"]
    assert items["type"] == "object"
    assert items["required"] == ["name", "balance", "annual_rate_pct", "minimum_payment"]
    assert items["additionalProperties"] is False


# --- errors over the wire -----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "arguments", "message"),
    [
        (
            "calculate_emi",
            {"principal": -5, "annual_rate_pct": 9, "tenure_months": 12},
            "Error executing tool calculate_emi: invalid arguments: principal: Input should be "
            "greater than or equal to 1",
        ),
        (
            "calculate_emi",
            {"principal": 100000, "annual_rate_pct": 9, "tenure_months": 0},
            "Error executing tool calculate_emi: invalid arguments: tenure_months: Input should "
            "be greater than or equal to 1",
        ),
        (
            "calculate_emi",
            {"principal": 100000, "annual_rate_pct": 101, "tenure_months": 12},
            "Error executing tool calculate_emi: invalid arguments: annual_rate_pct: Input should "
            "be less than or equal to 100",
        ),
        (
            "calculate_emi",
            {"principal": 100000, "annual_rate_pct": 9},
            "Error executing tool calculate_emi: invalid arguments: tenure_months: Field required",
        ),
        (
            "calculate_emi",
            {"principal": 100000, "annual_rate_pct": 9, "tenure_months": 12.5},
            "Error executing tool calculate_emi: invalid arguments: tenure_months: Input should "
            "be a valid integer, got a number with a fractional part",
        ),
        (
            "calculate_emi",
            {"principal": 100000, "rate": 9, "tenure_months": 12},
            "Error executing tool calculate_emi: unknown argument(s) rate; it takes principal, "
            "annual_rate_pct, tenure_months",
        ),
        (
            "get_client_profile",
            {"client_id": "x"},
            "Error executing tool get_client_profile: unknown argument(s) client_id; it takes "
            "no arguments",
        ),
        (
            "reference_rates",
            {"key": "fd_1y"},
            "Error executing tool reference_rates: unknown argument(s) key; it takes no arguments",
        ),
        (
            "amortization_schedule",
            {
                "principal": 100000,
                "annual_rate_pct": 9,
                "tenure_months": 12,
                "granularity": "daily",
            },
            "Error executing tool amortization_schedule: invalid arguments: granularity: Input "
            "should be 'yearly' or 'monthly'",
        ),
        (
            "debt_payoff_plan",
            {
                "debts": [
                    {"name": "A", "balance": 1000, "annual_rate_pct": 12, "minimum_payment": 500}
                ],
                "monthly_budget": 100,
            },
            "Error executing tool debt_payoff_plan: monthly_budget ₹100.00 is below the sum of "
            "minimum payments ₹500.00",
        ),
        (
            "debt_payoff_plan",
            {
                "debts": [
                    {
                        "name": "A",
                        "balance": 1000,
                        "annual_rate_pct": 12,
                        "minimum_payment": 5,
                        "emi": 1,
                    }
                ],
                "monthly_budget": 100,
            },
            "Error executing tool debt_payoff_plan: invalid arguments: debts[0].emi: Extra inputs "
            "are not permitted",
        ),
        (
            "prepayment_impact",
            {
                "outstanding_principal": 100000,
                "annual_rate_pct": 9,
                "remaining_months": 12,
                "prepayment_amount": 150000,
            },
            "Error executing tool prepayment_impact: prepayment_amount must be less than "
            "outstanding_principal",
        ),
        (
            "list_transactions",
            {"from_date": "2026/10/01"},
            "Error executing tool list_transactions: from_date must be a date in the form "
            "YYYY-MM-DD",
        ),
        (
            "sip_future_value",
            {
                "monthly_investment": 10000,
                "expected_annual_return_pct": 12,
                "years": 10,
                "lump_sum": -1,
            },
            "Error executing tool sip_future_value: invalid arguments: lump_sum: Input should be "
            "greater than or equal to 0",
        ),
        # The arithmetic tools (D54): a plain error on division by zero, bounds from the schema.
        (
            "divide",
            {"a": 1000, "b": 0},
            "Error executing tool divide: cannot divide by zero: b is 0",
        ),
        (
            "percent_change",
            {"from_value": 0, "to_value": 500},
            "Error executing tool percent_change: from_value is 0, so there is no percent change",
        ),
        (
            "add",
            {"values": []},
            "Error executing tool add: invalid arguments: values: List should have at least 2 "
            "items after validation, not 0",
        ),
        (
            "multiply",
            {"values": [5]},
            "Error executing tool multiply: invalid arguments: values: List should have at least "
            "2 items after validation, not 1",
        ),
        (
            "add",
            {"values": [1, 2000000000000]},
            "Error executing tool add: invalid arguments: values[1]: Input should be less than or "
            "equal to 1000000000000",
        ),
        (
            "multiply",
            {"values": [1000000, 1000000, 2]},
            "Error executing tool multiply: the product is outside -10^12 to 10^12",
        ),
        (
            "subtract",
            {"a": 100},
            "Error executing tool subtract: invalid arguments: b: Field required",
        ),
        (
            "round",
            {"value": 1.5, "places": 11},
            "Error executing tool round: invalid arguments: places: Input should be less than or "
            "equal to 10",
        ),
        (
            "round",
            {"value": 1.5, "digits": 0},
            "Error executing tool round: unknown argument(s) digits; it takes value, places",
        ),
        ("no_such_tool", {}, "Unknown tool: no_such_tool"),
    ],
)
def test_bad_calls_return_short_error_results(
    state_dir: Path, name: str, arguments: dict, message: str
) -> None:
    text = error(create_server(state_dir), name, arguments)
    assert message in text
    assert len(text) < 250
    assert "pydantic" not in text and "Traceback" not in text


def test_sip_lump_sum_over_the_wire(state_dir: Path) -> None:
    """The optional lump sum reaches the calculator; without it the result is unchanged."""
    server = create_server(state_dir)
    base = {"monthly_investment": 10000, "expected_annual_return_pct": 12, "years": 10}
    both = ok(server, "sip_future_value", {**base, "lump_sum": 100000})
    assert (both["lump_sum_value"], both["sip_value"], both["corpus"]) == (
        330038.69,
        2323390.76,
        2653429.45,
    )
    assert both["lump_sum_formatted"] == "₹1,00,000.00"
    plain = text_of(call(server, "sip_future_value", base))
    zero = text_of(call(server, "sip_future_value", {**base, "lump_sum": 0}))
    assert plain == zero
    assert "lump_sum" not in plain


def test_arithmetic_over_the_wire(state_dir: Path) -> None:
    """Each arithmetic tool returns one or two plain numbers in exact decimals, never its inputs,
    and no ₹ formatting, because the tools do not know the unit."""
    server = create_server(state_dir)
    texts = {
        name: text_of(call(server, name, arguments))
        for name, arguments in SAMPLE_CALLS
        if name in ARITHMETIC
    }
    assert texts == {
        "add": '{"sum":23120.00}',
        "subtract": '{"difference":74167.50}',
        "multiply": '{"product":107967.12}',
        "divide": '{"quotient":17142.86}',
        "percent_of": '{"amount":37000.00}',
        "percent_change": '{"change":9000.00,"change_pct":63.74}',
        "round": '{"rounded":23000}',
    }
    assert text_of(call(server, "add", {"values": [0.1, 0.2]})) == '{"sum":0.30}'
    assert text_of(call(server, "round", {"value": 2.345})) == '{"rounded":2.35}'


def test_a_tool_error_does_not_break_the_next_call(state_dir: Path) -> None:
    server = create_server(state_dir)
    error(server, "calculate_emi", {"principal": -1, "annual_rate_pct": 9, "tenure_months": 12})
    result = call(
        server, "calculate_emi", {"principal": 1000, "annual_rate_pct": 9, "tenure_months": 12}
    )
    assert not result.is_error


# --- transports ---------------------------------------------------------------------------------


async def test_in_process_modern_and_legacy_give_identical_bytes(state_dir: Path) -> None:
    legacy = await in_process_texts(state_dir)
    async with Client(create_server(state_dir)) as client:
        version, names, modern = await exercise(client)
    assert version == MODERN_VERSION
    assert names == EXPECTED_TOOLS
    assert modern == legacy


@pytest.mark.parametrize(
    ("mode", "expected_version"), [("legacy", "2025-11-25"), ("auto", MODERN_VERSION)]
)
async def test_stdio_transport(shared_state_dir: Path, mode: str, expected_version: str) -> None:
    command, args = stdio_command(shared_state_dir)
    async with Client(StdioServerParameters(command=command, args=args), mode=mode) as client:
        version, names, texts = await exercise(client)
        assert client.server_info is None or client.server_info.name == "finance-mcp"
    assert version == expected_version
    assert names == EXPECTED_TOOLS
    assert texts == await in_process_texts(shared_state_dir)


@pytest.mark.parametrize(
    ("mode", "expected_version"), [("legacy", "2025-11-25"), ("auto", MODERN_VERSION)]
)
async def test_http_transport(http_server, mode: str, expected_version: str) -> None:
    async with Client(http_server.url, mode=mode) as client:
        version, names, texts = await exercise(client)
    assert version == expected_version
    assert names == EXPECTED_TOOLS
    assert texts == await in_process_texts(http_server.state_dir)


async def _session_texts(session: ClientSession) -> tuple[str, list[str], list[str]]:
    init = await session.initialize()
    names = [t.name for t in (await session.list_tools()).tools]
    texts = []
    for name, arguments in SAMPLE_CALLS:
        texts.append(text_of(await session.call_tool(name, arguments)))
    bad = await session.call_tool(
        "calculate_emi", {"principal": -1, "annual_rate_pct": 9, "tenure_months": 1}
    )
    assert bad.is_error
    return init.protocol_version, names, texts


async def test_hermes_style_session_over_stdio(shared_state_dir: Path) -> None:
    command, args = stdio_command(shared_state_dir)
    async with (
        stdio_client(StdioServerParameters(command=command, args=args)) as streams,
        ClientSession(streams[0], streams[1]) as session,
    ):
        version, names, texts = await _session_texts(session)
    assert version == "2025-11-25"
    assert names == EXPECTED_TOOLS
    assert texts == await in_process_texts(shared_state_dir)


async def test_hermes_style_session_over_http(http_server) -> None:
    async with (
        streamable_http_client(http_server.url) as streams,
        ClientSession(streams[0], streams[1]) as session,
    ):
        version, names, texts = await _session_texts(session)
    assert version == "2025-11-25"
    assert names == EXPECTED_TOOLS
    assert texts == await in_process_texts(http_server.state_dir)


def _raw_post(url: str, body: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        assert response.headers["Content-Type"].startswith("application/json")
        return json.loads(response.read())


@pytest.mark.parametrize("version", HANDSHAKE_VERSIONS)
def test_http_initialize_accepts_every_handshake_version(http_server, version: str) -> None:
    reply = _raw_post(
        http_server.url,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": version,
                "capabilities": {},
                "clientInfo": {"name": "raw", "version": "0"},
            },
        },
    )
    assert reply["result"]["protocolVersion"] == version
    assert reply["result"]["serverInfo"]["name"] == "finance-mcp"
    assert set(reply["result"]["capabilities"]) >= {"tools"}


def test_http_initialize_with_unknown_version_counter_offers_latest(http_server) -> None:
    reply = _raw_post(
        http_server.url,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2023-01-01",
                "capabilities": {},
                "clientInfo": {"name": "raw", "version": "0"},
            },
        },
    )
    assert reply["result"]["protocolVersion"] == "2025-11-25"


def test_health_route(http_server) -> None:
    with urllib.request.urlopen(f"{http_server.base}/health", timeout=5) as response:
        assert response.status == 200
        assert json.loads(response.read()) == {"status": "ok"}


# --- determinism --------------------------------------------------------------------------------


def test_every_tool_twice_gives_byte_identical_output(state_dir: Path) -> None:
    server = create_server(state_dir)
    for name, arguments in SAMPLE_CALLS:
        first = text_of(call(server, name, arguments))
        second = text_of(call(server, name, arguments))
        third = text_of(call(create_server(state_dir), name, arguments))
        assert first == second == third, name


def test_outputs_are_compact_utf8_json(state_dir: Path) -> None:
    server = create_server(state_dir)
    for name, arguments in SAMPLE_CALLS:
        text = text_of(call(server, name, arguments))
        assert isinstance(json.loads(text), dict), name
        assert "\n" not in text and '",' + " " not in text and "\\u20b9" not in text, name


def test_largest_page_stays_small(state_dir: Path) -> None:
    """60 monthly rows is the biggest result a calculator returns; keep it well under the
    50,000 characters at which Hermes spills a tool result to a file."""
    text = text_of(
        call(
            create_server(state_dir),
            "amortization_schedule",
            {
                "principal": 5000000,
                "annual_rate_pct": 8.5,
                "tenure_months": 360,
                "granularity": "monthly",
            },
        )
    )
    assert json.loads(text)["rows_returned"] == 60
    assert len(text) < 25000
