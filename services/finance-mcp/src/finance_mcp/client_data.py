"""Per-trial client data, read-only, from `<state dir>/client.json`.

The file is read and validated on every call, so a runner can rewrite the state directory
between trials and the server never serves a stale copy. Floats are parsed as Decimal, so values
are echoed back exactly as written. A missing state directory or file means "no client on file";
a file that exists but fails validation is an error, because a trial built on it is broken.
"""

import json
import re
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    ValidationError,
    WithJsonSchema,
    model_validator,
)

from finance_mcp.money import ZERO, FinanceInputError, in_context, money

CLIENT_FILE = "client.json"
SCHEMA_VERSION = 1
MAX_TRANSACTIONS_LIMIT = 500
NO_CLIENT: dict[str, Any] = {"client_on_file": False, "message": "No client on file."}

_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CATEGORY_PATTERN = r"^[a-z][a-z0-9_]*$"


class ClientDataError(Exception):
    """client.json exists but cannot be used. The message is short and names the bad field."""


# --- schema -------------------------------------------------------------------------------------


def _json_number(value: object) -> object:
    if isinstance(value, bool) or not isinstance(value, int | Decimal):
        raise ValueError("must be a JSON number")
    return value


def _real_date(value: str) -> str:
    try:
        date.fromisoformat(value)
    except ValueError:
        raise ValueError("must be a real calendar date (YYYY-MM-DD)") from None
    return value


Money = Annotated[
    Decimal,
    BeforeValidator(_json_number),
    Field(ge=0, le=10**12, decimal_places=2),
    WithJsonSchema(
        {
            "type": "number",
            "minimum": 0,
            "maximum": 10**12,
            "description": "Rupees, at most 2 decimals.",
        }
    ),
]
PositiveMoney = Annotated[
    Decimal,
    BeforeValidator(_json_number),
    Field(ge=Decimal("0.01"), le=10**12, decimal_places=2),
    WithJsonSchema(
        {
            "type": "number",
            "minimum": 0.01,
            "maximum": 10**12,
            "description": "Rupees, at most 2 decimals.",
        }
    ),
]
RatePct = Annotated[
    Decimal,
    BeforeValidator(_json_number),
    Field(ge=0, le=100),
    WithJsonSchema({"type": "number", "minimum": 0, "maximum": 100}),
]
IsoDate = Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}$"), AfterValidator(_real_date)]
Category = Annotated[str, Field(pattern=_CATEGORY_PATTERN, max_length=40)]
ShortText = Annotated[str, Field(min_length=1, max_length=60)]


class Profile(BaseModel):
    """Free-form: the task decides what a client looks like. Only `name` is required."""

    model_config = ConfigDict(extra="allow")
    name: Annotated[str, Field(min_length=1, max_length=100)]


class Debt(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: ShortText
    kind: Category | None = None
    lender: ShortText | None = None
    balance: Money
    annual_rate_pct: RatePct
    minimum_payment: Money
    remaining_months: Annotated[int, Field(strict=True, ge=1, le=600)] | None = None


class Transaction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: Annotated[str, Field(min_length=1, max_length=40)]
    date: IsoDate
    description: Annotated[str, Field(max_length=200)]
    category: Category
    direction: Literal["debit", "credit"]
    amount: PositiveMoney


class ClientFile(BaseModel):
    """Top level of client.json."""

    model_config = ConfigDict(extra="forbid", title="finance-mcp client.json")
    schema_version: Literal[1]
    synthetic: Annotated[bool, Field(strict=True)] = False
    profile: Profile
    debts: list[Debt] = []
    transactions: list[Transaction] = []

    @model_validator(mode="after")
    def _unique_keys(self) -> ClientFile:
        names = [debt.name for debt in self.debts]
        if len(set(names)) != len(names):
            raise ValueError("debt names must be unique")
        ids = [txn.id for txn in self.transactions]
        if len(set(ids)) != len(ids):
            raise ValueError("transaction ids must be unique")
        return self


def client_json_schema() -> dict[str, Any]:
    """The published JSON Schema for client.json (schemas/client.schema.json)."""
    return ClientFile.model_json_schema()


# --- loading ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class ClientRecord:
    profile: dict[str, Any]
    """The profile object exactly as written in the file, key order kept."""
    data: ClientFile


def _no_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate key {key!r}")
        result[key] = value
    return result


def _reject_constant(name: str) -> None:
    raise ValueError(f"{name} is not allowed")


def _location(loc: tuple[int | str, ...]) -> str:
    text = ""
    for part in loc:
        text += f"[{part}]" if isinstance(part, int) else (f".{part}" if text else str(part))
    return text or "(top level)"


def parse_client(raw: bytes) -> ClientRecord:
    try:
        data = json.loads(
            raw.decode("utf-8"),
            parse_float=Decimal,
            parse_constant=_reject_constant,
            object_pairs_hook=_no_duplicate_keys,
        )
    except UnicodeDecodeError:
        raise ClientDataError("client.json is not UTF-8") from None
    except json.JSONDecodeError as exc:
        raise ClientDataError(
            f"client.json is not valid JSON (line {exc.lineno}, column {exc.colno}: {exc.msg})"
        ) from None
    except ValueError as exc:
        raise ClientDataError(f"client.json is not valid JSON: {exc}") from None
    try:
        model = ClientFile.model_validate(data)
    except ValidationError as exc:
        first = exc.errors()[0]
        more = f" (and {exc.error_count() - 1} more)" if exc.error_count() > 1 else ""
        raise ClientDataError(
            f"client.json is invalid: {_location(first['loc'])}: {first['msg']}{more}"
        ) from None
    return ClientRecord(profile=data["profile"], data=model)


def load_client(state_dir: Path | None) -> ClientRecord | None:
    """None when no state directory is configured or it holds no client.json."""
    if state_dir is None:
        return None
    path = state_dir / CLIENT_FILE
    try:
        raw = path.read_bytes()
    except FileNotFoundError, NotADirectoryError:
        return None
    except OSError as exc:
        raise ClientDataError(f"client.json could not be read ({exc.strerror})") from None
    return parse_client(raw)


# --- views --------------------------------------------------------------------------------------


def profile_view(record: ClientRecord | None) -> dict[str, Any]:
    if record is None:
        return dict(NO_CLIENT)
    return {"client_on_file": True, "profile": record.profile}


@in_context
def debts_view(record: ClientRecord | None) -> dict[str, Any]:
    if record is None:
        return dict(NO_CLIENT)
    items = []
    for debt in record.data.debts:
        item: dict[str, Any] = {"name": debt.name}
        if debt.kind is not None:
            item["kind"] = debt.kind
        if debt.lender is not None:
            item["lender"] = debt.lender
        item |= money("balance", debt.balance, words=True)
        item["annual_rate_pct"] = debt.annual_rate_pct
        item |= money("minimum_payment", debt.minimum_payment)
        if debt.remaining_months is not None:
            item["remaining_months"] = debt.remaining_months
        items.append(item)
    debts = record.data.debts
    return {
        "client_on_file": True,
        "count": len(debts),
        **money("total_balance", sum((d.balance for d in debts), ZERO), words=True),
        **money("total_minimum_payments", sum((d.minimum_payment for d in debts), ZERO)),
        "debts": items,
    }


def _date_filter(value: object, name: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not _DATE.match(value):
        raise FinanceInputError(f"{name} must be a date in the form YYYY-MM-DD")
    try:
        date.fromisoformat(value)
    except ValueError:
        raise FinanceInputError(f"{name} must be a real calendar date (YYYY-MM-DD)") from None
    return value


@in_context
def transactions_view(
    record: ClientRecord | None,
    category: object = None,
    from_date: object = None,
    to_date: object = None,
    limit: object = 50,
) -> dict[str, Any]:
    """Filters: category is an exact match after trimming and lower-casing; dates are inclusive
    and compared as ISO strings. Matches are sorted by date, ties in file order. Totals cover
    every match; only the first `limit` matches are listed."""
    wanted: str | None = None
    if category is not None:
        if not isinstance(category, str) or not category.strip():
            raise FinanceInputError("category must be a non-empty string")
        wanted = category.strip().lower()
    start = _date_filter(from_date, "from_date")
    end = _date_filter(to_date, "to_date")
    if start is not None and end is not None and start > end:
        raise FinanceInputError("from_date must not be after to_date")
    if (
        isinstance(limit, bool)
        or not isinstance(limit, int)
        or not 1 <= limit <= MAX_TRANSACTIONS_LIMIT
    ):
        raise FinanceInputError(
            f"limit must be a whole number between 1 and {MAX_TRANSACTIONS_LIMIT}"
        )
    if record is None:
        return dict(NO_CLIENT)

    everything = record.data.transactions
    matches = sorted(
        (
            txn
            for txn in everything
            if (wanted is None or txn.category == wanted)
            and (start is None or txn.date >= start)
            and (end is None or txn.date <= end)
        ),
        key=lambda txn: txn.date,
    )
    debits = sum((t.amount for t in matches if t.direction == "debit"), ZERO)
    credits = sum((t.amount for t in matches if t.direction == "credit"), ZERO)
    shown = matches[:limit]
    return {
        "client_on_file": True,
        "match_count": len(matches),
        "returned_count": len(shown),
        "truncated": len(shown) < len(matches),
        **money("total_debits", debits, words=True),
        **money("total_credits", credits, words=True),
        **money("net", credits - debits, words=True),
        "available_categories": sorted({t.category for t in everything}),
        "transactions": [
            {
                "id": t.id,
                "date": t.date,
                "description": t.description,
                "category": t.category,
                "direction": t.direction,
                **money("amount", t.amount),
            }
            for t in shown
        ],
    }


if __name__ == "__main__":
    print(json.dumps(client_json_schema(), indent=2, ensure_ascii=False))
