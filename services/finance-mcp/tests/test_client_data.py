import json
from decimal import Decimal
from pathlib import Path

import pytest
from finance_mcp.client_data import (
    ClientDataError,
    client_json_schema,
    debts_view,
    load_client,
    parse_client,
    profile_view,
    transactions_view,
)
from finance_mcp.money import FinanceInputError
from finance_mcp.server import create_server
from support import EXAMPLE_CLIENT, ROOT, call, error, ok, text_of

SCHEMA_FILE = ROOT / "schemas" / "client.schema.json"


def minimal(**overrides) -> dict:
    data = {"schema_version": 1, "profile": {"name": "Test Client"}}
    data.update(overrides)
    return data


def write(tmp_path: Path, data: dict | str) -> Path:
    text = data if isinstance(data, str) else json.dumps(data)
    (tmp_path / "client.json").write_text(text, encoding="utf-8")
    return tmp_path


# --- missing ------------------------------------------------------------------------------------


def test_no_state_dir_and_missing_file_mean_no_client(tmp_path: Path) -> None:
    for state_dir in (None, tmp_path, tmp_path / "does-not-exist"):
        record = load_client(state_dir)
        assert record is None
        assert profile_view(record) == {"client_on_file": False, "message": "No client on file."}
        assert debts_view(record)["client_on_file"] is False
        assert transactions_view(record)["client_on_file"] is False


def test_missing_file_is_a_result_not_an_error_over_mcp(tmp_path: Path) -> None:
    server = create_server(tmp_path)
    for name in ("get_client_profile", "list_debts", "list_transactions"):
        assert ok(server, name, {}) == {"client_on_file": False, "message": "No client on file."}


# --- valid --------------------------------------------------------------------------------------


def test_example_file_is_valid_and_marked_synthetic() -> None:
    record = parse_client(EXAMPLE_CLIENT.read_bytes())
    assert record.data.synthetic is True
    assert "SYNTHETIC" in record.profile["notes"]
    assert len(record.data.debts) == 3
    assert len(record.data.transactions) == 16


def test_profile_is_echoed_exactly_in_file_order(state_dir: Path) -> None:
    server = create_server(state_dir)
    result = ok(server, "get_client_profile", {})
    original = json.loads(EXAMPLE_CLIENT.read_text(encoding="utf-8"))["profile"]
    assert result == {"client_on_file": True, "profile": original}
    assert list(result["profile"]) == list(original)


def test_profile_numbers_keep_their_digits_and_exponents_are_written_out(tmp_path: Path) -> None:
    write(tmp_path, '{"schema_version": 1, "profile": {"name": "A", "income": 85000.50, "x": 1e5}}')
    server = create_server(tmp_path)
    text = text_of(call(server, "get_client_profile", {}))
    assert text == '{"client_on_file":true,"profile":{"name":"A","income":85000.50,"x":100000}}'


def test_list_debts(state_dir: Path) -> None:
    result = debts_view(load_client(state_dir))
    assert result["count"] == 3
    assert result["total_balance"] == Decimal("441050.00")
    assert result["total_balance_formatted"] == "₹4,41,050.00"
    assert result["total_balance_words"] == "4.41 lakh"
    assert result["total_minimum_payments"] == Decimal("18332.50")
    card = result["debts"][0]
    assert card == {
        "name": "Credit card",
        "kind": "credit_card",
        "lender": "Kaveri Bank (fictional)",
        "balance": Decimal("84250.00"),
        "balance_formatted": "₹84,250.00",
        "annual_rate_pct": Decimal(42),
        "minimum_payment": Decimal("4212.50"),
        "minimum_payment_formatted": "₹4,212.50",
    }
    assert result["debts"][1]["remaining_months"] == 36


def test_list_debts_output_feeds_debt_payoff_plan(state_dir: Path) -> None:
    server = create_server(state_dir)
    debts = ok(server, "list_debts", {})["debts"]
    plan = ok(
        server,
        "debt_payoff_plan",
        {
            "debts": [
                {k: d[k] for k in ("name", "balance", "annual_rate_pct", "minimum_payment")}
                for d in debts
            ],
            "monthly_budget": 25000,
        },
    )
    assert plan["payoff_order"][0] == "Credit card"


# --- transactions -------------------------------------------------------------------------------


def test_all_transactions_with_totals(state_dir: Path) -> None:
    result = transactions_view(load_client(state_dir))
    assert result["match_count"] == result["returned_count"] == 16
    assert result["truncated"] is False
    assert result["total_credits"] == Decimal("93799.00")
    assert result["total_debits"] == Decimal("89869.15")
    assert result["net"] == Decimal("3929.85")
    assert result["available_categories"][:3] == ["card_payment", "dining", "education"]


def test_category_filter_is_case_insensitive_exact(state_dir: Path) -> None:
    record = load_client(state_dir)
    result = transactions_view(record, category="  Medical ")
    assert [t["id"] for t in result["transactions"]] == ["t007", "t012"]
    assert result["total_debits"] == Decimal("6880.00")
    assert transactions_view(record, category="med")["match_count"] == 0


def test_date_range_is_inclusive_and_lexical(state_dir: Path) -> None:
    record = load_client(state_dir)
    result = transactions_view(record, from_date="2026-10-03", to_date="2026-10-06")
    assert [t["id"] for t in result["transactions"]] == ["t003", "t004", "t005", "t006"]
    assert transactions_view(record, from_date="2026-10-30")["match_count"] == 1
    assert transactions_view(record, to_date="2026-09-30")["match_count"] == 0


def test_limit_truncates_but_totals_cover_every_match(state_dir: Path) -> None:
    record = load_client(state_dir)
    result = transactions_view(record, category="groceries", limit=1)
    assert result["match_count"] == 2
    assert result["returned_count"] == 1
    assert result["truncated"] is True
    assert result["total_debits"] == Decimal("8086.25")
    assert result["transactions"][0]["id"] == "t005"


def test_transactions_sorted_by_date_ties_in_file_order(tmp_path: Path) -> None:
    txns = [
        {
            "id": "b",
            "date": "2026-02-01",
            "description": "",
            "category": "x",
            "direction": "debit",
            "amount": 1,
        },
        {
            "id": "a",
            "date": "2026-01-01",
            "description": "",
            "category": "x",
            "direction": "debit",
            "amount": 1,
        },
        {
            "id": "c",
            "date": "2026-02-01",
            "description": "",
            "category": "x",
            "direction": "debit",
            "amount": 1,
        },
    ]
    record = load_client(write(tmp_path, minimal(transactions=txns)))
    assert [t["id"] for t in transactions_view(record)["transactions"]] == ["a", "b", "c"]


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"from_date": "01-10-2026"}, "from_date must be a date in the form YYYY-MM-DD"),
        ({"to_date": "2026-02-30"}, "to_date must be a real calendar date"),
        (
            {"from_date": "2026-10-31", "to_date": "2026-10-01"},
            "from_date must not be after to_date",
        ),
        ({"category": "  "}, "category must be a non-empty string"),
        ({"limit": 0}, "limit must be a whole number between 1 and 500"),
        ({"limit": 501}, "limit must be a whole number between 1 and 500"),
    ],
)
def test_bad_transaction_filters(state_dir: Path, kwargs: dict, message: str) -> None:
    with pytest.raises(FinanceInputError, match=message):
        transactions_view(load_client(state_dir), **kwargs)


# --- invalid files ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("content", "message"),
    [
        ("{not json", "client.json is not valid JSON (line 1, column 2"),
        (
            '{"schema_version": 1, "schema_version": 1, "profile": {"name": "A"}}',
            "duplicate key 'schema_version'",
        ),
        ('{"schema_version": 1, "profile": {"name": "A", "x": NaN}}', "NaN is not allowed"),
        (json.dumps(minimal(schema_version=2)), "schema_version: Input should be 1"),
        (json.dumps({"schema_version": 1}), "profile: Field required"),
        (json.dumps(minimal(profile={"age": 30})), "profile.name: Field required"),
        (json.dumps(minimal(extra=1)), "extra: Extra inputs are not permitted"),
        (
            json.dumps(
                minimal(
                    debts=[{"name": "A", "balance": -1, "annual_rate_pct": 1, "minimum_payment": 0}]
                )
            ),
            "debts[0].balance: Input should be greater than or equal to 0",
        ),
        (
            json.dumps(
                minimal(
                    debts=[
                        {"name": "A", "balance": "100", "annual_rate_pct": 1, "minimum_payment": 0}
                    ]
                )
            ),
            "debts[0].balance: Value error, must be a JSON number",
        ),
        (
            json.dumps(
                minimal(
                    debts=[
                        {"name": "A", "balance": 1.001, "annual_rate_pct": 1, "minimum_payment": 0}
                    ]
                )
            ),
            "debts[0].balance: Decimal input should have no more than 2 decimal places",
        ),
        (
            json.dumps(
                minimal(
                    debts=[
                        {
                            "name": "A",
                            "balance": 1,
                            "annual_rate_pct": 1,
                            "minimum_payment": 0,
                            "emi": 5,
                        }
                    ]
                )
            ),
            "debts[0].emi: Extra inputs are not permitted",
        ),
        (
            json.dumps(
                minimal(
                    transactions=[
                        {
                            "id": "1",
                            "date": "2026-13-01",
                            "description": "",
                            "category": "x",
                            "direction": "debit",
                            "amount": 1,
                        }
                    ]
                )
            ),
            "transactions[0].date: Value error, must be a real calendar date",
        ),
        (
            json.dumps(
                minimal(
                    transactions=[
                        {
                            "id": "1",
                            "date": "2026-01-01",
                            "description": "",
                            "category": "Food",
                            "direction": "debit",
                            "amount": 1,
                        }
                    ]
                )
            ),
            "transactions[0].category: String should match pattern",
        ),
        (
            json.dumps(
                minimal(
                    transactions=[
                        {
                            "id": "1",
                            "date": "2026-01-01",
                            "description": "",
                            "category": "x",
                            "direction": "out",
                            "amount": 1,
                        }
                    ]
                )
            ),
            "transactions[0].direction: Input should be 'debit' or 'credit'",
        ),
        (
            json.dumps(
                minimal(
                    transactions=[
                        {
                            "id": "1",
                            "date": "2026-01-01",
                            "description": "",
                            "category": "x",
                            "direction": "debit",
                            "amount": 1,
                        }
                    ]
                    * 2
                )
            ),
            "transaction ids must be unique",
        ),
    ],
)
def test_invalid_file_is_rejected_with_the_field_named(
    tmp_path: Path, content: str, message: str
) -> None:
    write(tmp_path, content)
    with pytest.raises(ClientDataError) as caught:
        load_client(tmp_path)
    assert message in str(caught.value)


def test_invalid_file_is_a_tool_error_over_mcp(tmp_path: Path) -> None:
    write(tmp_path, minimal(debts=[{"name": "A"}]))
    server = create_server(tmp_path)
    message = error(server, "list_debts", {})
    assert message.startswith(
        "Error executing tool list_debts: client.json is invalid: debts[0].balance: Field required"
    )
    assert "(and 2 more)" in message


def test_file_is_re_read_on_every_call(tmp_path: Path) -> None:
    server = create_server(tmp_path)
    assert ok(server, "get_client_profile", {})["client_on_file"] is False
    write(tmp_path, minimal())
    assert ok(server, "get_client_profile", {})["profile"] == {"name": "Test Client"}


def test_published_json_schema_is_current() -> None:
    """schemas/client.schema.json is generated from the models; regenerate with
    `uv run python -m finance_mcp.client_data > schemas/client.schema.json` if this fails."""
    assert json.loads(SCHEMA_FILE.read_text(encoding="utf-8")) == client_json_schema()
