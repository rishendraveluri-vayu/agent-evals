"""Helpers shared by the tests: sample calls, an in-process MCP call wrapper, ports."""

import json
import socket
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import anyio
from finance_mcp.server import FinanceServer
from mcp import Client
from mcp_types import CallToolResult

ROOT = Path(__file__).resolve().parents[1]
EXAMPLE_CLIENT = ROOT / "examples" / "client.example.json"
SNAPSHOT = Path(__file__).resolve().parent / "snapshots" / "tools_manifest.json"

# One representative, valid call per tool. Used by the transport, determinism and compat tests.
SAMPLE_CALLS: list[tuple[str, dict[str, Any]]] = [
    ("calculate_emi", {"principal": 1000000, "annual_rate_pct": 9, "tenure_months": 240}),
    ("amortization_schedule", {"principal": 500000, "annual_rate_pct": 8.5, "tenure_months": 30}),
    (
        "prepayment_impact",
        {
            "outstanding_principal": 1000000,
            "annual_rate_pct": 9,
            "remaining_months": 240,
            "prepayment_amount": 200000,
            "mode": "reduce_emi",
        },
    ),
    (
        "debt_payoff_plan",
        {
            "debts": [
                {"name": "Card", "balance": 50000, "annual_rate_pct": 36, "minimum_payment": 2500},
                {"name": "Loan", "balance": 120000, "annual_rate_pct": 14, "minimum_payment": 4000},
            ],
            "monthly_budget": 12000,
            "strategy": "snowball",
        },
    ),
    (
        "sip_future_value",
        {
            "monthly_investment": 10000,
            "expected_annual_return_pct": 12,
            "years": 10,
            "annual_step_up_pct": 10,
        },
    ),
    ("fd_maturity", {"principal": 100000, "annual_rate_pct": 7, "years": 5}),
    ("inflation_adjusted_value", {"amount": 100000, "annual_inflation_pct": 6, "years": 10}),
    (
        "loan_affordability",
        {
            "monthly_net_income": 100000,
            "existing_monthly_emis": 20000,
            "annual_rate_pct": 9,
            "tenure_months": 240,
        },
    ),
    ("get_client_profile", {}),
    ("list_debts", {}),
    (
        "list_transactions",
        {"category": "medical", "from_date": "2026-10-01", "to_date": "2026-10-31"},
    ),
    # The arithmetic tools (D54, 5 Nov).
    ("add", {"values": [14120, 9000]}),
    ("subtract", {"a": 92500, "b": 18332.5}),
    ("multiply", {"values": [8997.26, 12]}),
    ("divide", {"a": 120000, "b": 7}),
    ("percent_of", {"value": 92500, "percent": 40}),
    ("percent_change", {"from_value": 14120, "to_value": 23120}),
    ("round", {"value": 23120.456, "places": -3}),
    # The reference rates (D58, 5 Nov).
    ("reference_rates", {}),
    # The document library (D79, 6 Nov), only in the finance-rag toolset.
    ("search_documents", {"query": "fixed deposit rate 2 years"}),
]

EXPECTED_TOOLS = [name for name, _ in SAMPLE_CALLS]
ARITHMETIC = ["add", "subtract", "multiply", "divide", "percent_of", "percent_change", "round"]


def text_of(result: CallToolResult) -> str:
    assert len(result.content) == 1, result.content
    assert result.content[0].type == "text"
    assert result.structured_content is None
    return result.content[0].text


def call(server: FinanceServer, name: str, arguments: dict[str, Any]) -> CallToolResult:
    """Call one tool through a real in-process MCP client (initialize handshake)."""

    async def go() -> CallToolResult:
        async with Client(server, mode="legacy") as client:
            return await client.call_tool(name, arguments)

    return anyio.run(go)


def ok(server: FinanceServer, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    result = call(server, name, arguments)
    assert not result.is_error, text_of(result)
    return json.loads(text_of(result))


def error(server: FinanceServer, name: str, arguments: dict[str, Any]) -> str:
    result = call(server, name, arguments)
    assert result.is_error, text_of(result)
    return text_of(result)


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@dataclass
class HttpServer:
    url: str
    base: str
    state_dir: Path


def stdio_command(state_dir: Path) -> tuple[str, list[str]]:
    return sys.executable, [
        "-m",
        "finance_mcp",
        "--transport",
        "stdio",
        "--state-dir",
        str(state_dir),
    ]
