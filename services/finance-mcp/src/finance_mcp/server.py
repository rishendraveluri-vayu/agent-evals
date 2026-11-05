"""The MCP server: 19 read-only tools over the calculators, the client file, the arithmetic
module and the reference rates (eight calculators, three client tools, and since 5 Nov seven
arithmetic tools, D54, and `reference_rates`, D58).

What every harness sees is decided here, so three things are pinned:

- **Schemas are flat.** Each published inputSchema is self-contained: no `$ref`/`$defs`, no
  `title`, no nullable `anyOf`, an explicit `type` on every node, and every object carries
  `properties`, `required` and `additionalProperties: false`. Harnesses that rewrite schemas
  (LangGraph inlines refs and strips titles; Hermes collapses nullable unions and always adds
  `required`) then have nothing left to rewrite.
- **Results are text only.** One TextContent holding canonical JSON (see output.py), with no
  structuredContent or outputSchema, because harnesses differ in which of the two they show the
  model; with one channel they all see the same bytes.
- **Errors are short.** Bad input comes back as an `isError` result: `Error executing tool <name>:
  <reason>`, never a traceback or a pydantic dump.
"""

import inspect
from collections.abc import Callable
from pathlib import Path
from typing import Annotated, Any, Literal

from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError, UnexpectedToolError
from mcp.server.mcpserver.tools import Tool
from mcp_types import CallToolResult, TextContent, ToolAnnotations
from mcp_types import Tool as MCPTool
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from finance_mcp import __version__, arithmetic, calculators, reference
from finance_mcp.client_data import (
    MAX_TRANSACTIONS_LIMIT,
    ClientDataError,
    debts_view,
    load_client,
    profile_view,
    transactions_view,
)
from finance_mcp.money import FinanceInputError
from finance_mcp.output import to_json

SERVER_NAME = "finance-mcp"
MAX_RUPEES = 10**12

READ_ONLY = ToolAnnotations(read_only_hint=True, open_world_hint=False)

# --- parameter types (the descriptions and ranges here are what the model reads) ---------------

LoanPrincipal = Annotated[float, Field(description="Loan amount in rupees.", ge=1, le=MAX_RUPEES)]
AnnualRatePct = Annotated[
    float, Field(description="Interest rate in percent per year (9 means 9%).", ge=0, le=100)
]
TenureMonths = Annotated[int, Field(description="Loan tenure in months.", ge=1, le=600)]

# The arithmetic tools (D54) take any unit, rupees, months or counts, within the money ceiling
# both ways.
Number = Annotated[float, Field(ge=-MAX_RUPEES, le=MAX_RUPEES)]


class DebtArg(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Annotated[
        str,
        Field(description="Label for this debt, unique in the list.", min_length=1, max_length=60),
    ]
    balance: Annotated[
        float, Field(description="Outstanding balance in rupees.", ge=1, le=MAX_RUPEES)
    ]
    annual_rate_pct: AnnualRatePct
    minimum_payment: Annotated[
        float, Field(description="Minimum monthly payment in rupees.", ge=0, le=MAX_RUPEES)
    ]


# --- schema flattening --------------------------------------------------------------------------

_KEY_ORDER = (
    "type",
    "description",
    "enum",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "default",
    "items",
    "properties",
    "required",
    "additionalProperties",
)


# The 2025-11-25 wire model serialises a root inputSchema as properties, required, type and then
# any other keys; the 2026-07-28 path keeps our order. Emitting the root in the wire model's order
# makes both protocol eras send the same bytes.
_ROOT_ORDER = ("properties", "required", "type", "additionalProperties")


def flatten_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Make a pydantic-generated schema self-contained and harness-proof (see module docstring).
    Raises ValueError on anything it cannot flatten, so a bad signature fails at startup."""
    flat = _flatten(schema, schema.get("$defs", {}))
    if flat["type"] != "object":
        raise ValueError("a tool's inputSchema must be an object")
    ordered = {key: flat[key] for key in _ROOT_ORDER}
    return ordered | {key: value for key, value in flat.items() if key not in ordered}


def _flatten(node: dict[str, Any], defs: dict[str, Any]) -> dict[str, Any]:
    if "$ref" in node:
        target = defs[node["$ref"].removeprefix("#/$defs/")]
        return _flatten({**target, **{k: v for k, v in node.items() if k != "$ref"}}, defs)
    if "anyOf" in node:
        options = [option for option in node["anyOf"] if option != {"type": "null"}]
        if len(options) != 1 or len(node["anyOf"]) != 2:
            raise ValueError(f"cannot flatten a non-nullable union: {node['anyOf']}")
        rest = {k: v for k, v in node.items() if k != "anyOf"}
        if rest.get("default", ...) is None:
            del rest["default"]
        return _flatten({**options[0], **rest}, defs)

    out: dict[str, Any] = {}
    for key, value in node.items():
        if key in ("title", "$defs"):
            continue
        if key == "properties":
            out[key] = {name: _flatten(sub, defs) for name, sub in value.items()}
        elif key == "items":
            out[key] = _flatten(value, defs)
        else:
            out[key] = value
    if "type" not in out:
        raise ValueError(f"schema node has no type: {node}")
    if out["type"] == "object":
        out.setdefault("properties", {})
        out.setdefault("required", [])
        out["additionalProperties"] = False
    ordered = {key: out[key] for key in _KEY_ORDER if key in out}
    ordered |= {key: out[key] for key in sorted(out) if key not in ordered}
    return ordered


def _location(loc: tuple[int | str, ...]) -> str:
    text = ""
    for part in loc:
        text += f"[{part}]" if isinstance(part, int) else (f".{part}" if text else str(part))
    return text


def summarise_validation(exc: ValidationError, limit: int = 3) -> str:
    errors = exc.errors()
    parts = [f"{_location(err['loc'])}: {err['msg']}" for err in errors[:limit]]
    if len(errors) > limit:
        parts.append(f"and {len(errors) - limit} more")
    return "; ".join(parts)


# --- server -------------------------------------------------------------------------------------


class FinanceServer(MCPServer):
    """MCPServer with flat published schemas, unknown-argument rejection and short messages."""

    def __init__(self) -> None:
        super().__init__(name=SERVER_NAME, version=__version__)
        self._arg_names: dict[str, tuple[str, ...]] = {}
        self._flat: dict[str, dict[str, Any]] = {}

    def register(
        self, fn: Callable[..., CallToolResult], description: str, name: str | None = None
    ) -> None:
        """Add a read-only tool and flatten its schema now, so a bad signature fails at startup.
        `name` overrides the function's name (`round`, which would shadow the builtin)."""
        name = name or fn.__name__
        self.add_tool(fn, name=name, description=description, annotations=READ_ONLY)
        self._arg_names[name] = tuple(inspect.signature(fn).parameters)
        self._flat[name] = flatten_schema(Tool.from_function(fn).parameters)

    async def list_tools(self) -> list[MCPTool]:
        tools = await super().list_tools()
        return [tool.model_copy(update={"input_schema": self._flat[tool.name]}) for tool in tools]

    async def call_tool(
        self, name: str, arguments: dict[str, Any], context: Context[Any, Any] | None = None
    ) -> Any:
        allowed = self._arg_names.get(name)
        if allowed is not None:
            unknown = sorted(set(arguments) - set(allowed))
            if unknown:
                takes = ", ".join(allowed) if allowed else "no arguments"
                raise ToolError(
                    f"Error executing tool {name}: unknown argument(s) {', '.join(unknown)}; "
                    f"it takes {takes}"
                )
        try:
            return await super().call_tool(name, arguments, context)
        except ToolError as exc:
            cause = exc.__cause__
            if isinstance(cause, ValidationError) and not isinstance(exc, UnexpectedToolError):
                raise ToolError(
                    f"Error executing tool {name}: invalid arguments: {summarise_validation(cause)}"
                ) from cause
            raise


def _text(fn: Callable[..., dict[str, Any]], *args: Any, **kwargs: Any) -> CallToolResult:
    try:
        value = fn(*args, **kwargs)
    except (FinanceInputError, ClientDataError) as exc:
        raise ToolError(str(exc)) from None
    return CallToolResult(content=[TextContent(type="text", text=to_json(value))])


def create_server(state_dir: Path | None) -> FinanceServer:
    """Build the server. `state_dir` holds this trial's client.json, or is None for none.
    The reference rates are read and checked here, so a malformed file fails at startup."""
    server = FinanceServer()
    rates = reference.load()

    def calculate_emi(
        principal: LoanPrincipal, annual_rate_pct: AnnualRatePct, tenure_months: TenureMonths
    ) -> CallToolResult:
        return _text(calculators.calculate_emi, principal, annual_rate_pct, tenure_months)

    def amortization_schedule(
        principal: LoanPrincipal,
        annual_rate_pct: AnnualRatePct,
        tenure_months: TenureMonths,
        granularity: Annotated[
            Literal["yearly", "monthly"],
            Field(description="Row size: 'yearly' (12 months per row) or 'monthly'."),
        ] = "yearly",
        start_period: Annotated[
            int,
            Field(description="First row to return: year or month number, from 1.", ge=1, le=600),
        ] = 1,
    ) -> CallToolResult:
        return _text(
            calculators.amortization_schedule,
            principal,
            annual_rate_pct,
            tenure_months,
            granularity,
            start_period,
        )

    def prepayment_impact(
        outstanding_principal: Annotated[
            float,
            Field(description="Loan balance outstanding today, in rupees.", ge=1, le=MAX_RUPEES),
        ],
        annual_rate_pct: AnnualRatePct,
        remaining_months: Annotated[
            int, Field(description="Months left on the loan.", ge=1, le=600)
        ],
        prepayment_amount: Annotated[
            float,
            Field(
                description="One-time part-prepayment in rupees, less than the outstanding amount.",
                ge=1,
                le=MAX_RUPEES,
            ),
        ],
        mode: Annotated[
            Literal["reduce_tenure", "reduce_emi"],
            Field(description="'reduce_tenure' keeps the EMI; 'reduce_emi' keeps the tenure."),
        ] = "reduce_tenure",
    ) -> CallToolResult:
        return _text(
            calculators.prepayment_impact,
            outstanding_principal,
            annual_rate_pct,
            remaining_months,
            prepayment_amount,
            mode,
        )

    def debt_payoff_plan(
        debts: Annotated[
            list[DebtArg],
            Field(description="The debts to pay off, 1 to 20.", min_length=1, max_length=20),
        ],
        monthly_budget: Annotated[
            float,
            Field(
                description="Total paid towards all debts each month, in rupees.",
                ge=1,
                le=MAX_RUPEES,
            ),
        ],
        strategy: Annotated[
            Literal["avalanche", "snowball"],
            Field(
                description="'avalanche' (highest rate first) or 'snowball' "
                "(smallest balance first)."
            ),
        ] = "avalanche",
    ) -> CallToolResult:
        return _text(
            calculators.debt_payoff_plan,
            [debt.model_dump() for debt in debts],
            monthly_budget,
            strategy,
        )

    def sip_future_value(
        monthly_investment: Annotated[
            float, Field(description="Monthly SIP amount in rupees.", ge=1, le=MAX_RUPEES)
        ],
        expected_annual_return_pct: Annotated[
            float, Field(description="Expected return in percent per year.", ge=0, le=100)
        ],
        years: Annotated[int, Field(description="Investment period in whole years.", ge=1, le=50)],
        annual_step_up_pct: Annotated[
            float,
            Field(
                description="Increase in the monthly amount every 12 months, in percent.",
                ge=0,
                le=100,
            ),
        ] = 0,
        lump_sum: Annotated[
            float,
            Field(
                description="One-time amount invested at the start, in rupees; it grows at the "
                "same rate. 0 for none.",
                ge=0,
                le=MAX_RUPEES,
            ),
        ] = 0,
    ) -> CallToolResult:
        return _text(
            calculators.sip_future_value,
            monthly_investment,
            expected_annual_return_pct,
            years,
            annual_step_up_pct,
            lump_sum,
        )

    def fd_maturity(
        principal: Annotated[
            float, Field(description="Deposit amount in rupees.", ge=1, le=MAX_RUPEES)
        ],
        annual_rate_pct: AnnualRatePct,
        years: Annotated[
            float,
            Field(description="Deposit tenure in years; 1.5 means 18 months.", ge=0.01, le=50),
        ],
        compounding: Annotated[
            Literal["quarterly", "monthly", "annually"],
            Field(description="How often interest compounds."),
        ] = "quarterly",
    ) -> CallToolResult:
        return _text(calculators.fd_maturity, principal, annual_rate_pct, years, compounding)

    def inflation_adjusted_value(
        amount: Annotated[float, Field(description="Amount in rupees.", ge=1, le=MAX_RUPEES)],
        annual_inflation_pct: Annotated[
            float, Field(description="Inflation in percent per year.", ge=0, le=100)
        ],
        years: Annotated[int, Field(description="Number of whole years.", ge=1, le=100)],
        direction: Annotated[
            Literal["future_cost", "present_value"],
            Field(
                description="'future_cost': what today's amount will cost later; "
                "'present_value': what a future amount is worth today."
            ),
        ] = "future_cost",
    ) -> CallToolResult:
        return _text(
            calculators.inflation_adjusted_value, amount, annual_inflation_pct, years, direction
        )

    def loan_affordability(
        monthly_net_income: Annotated[
            float, Field(description="Take-home income per month in rupees.", ge=1, le=MAX_RUPEES)
        ],
        existing_monthly_emis: Annotated[
            float,
            Field(description="EMIs already paid each month, in rupees.", ge=0, le=MAX_RUPEES),
        ],
        annual_rate_pct: AnnualRatePct,
        tenure_months: TenureMonths,
        max_foir_pct: Annotated[
            float,
            Field(
                description="FOIR limit: maximum total EMIs as a percent of net income.",
                ge=1,
                le=100,
            ),
        ] = 50,
    ) -> CallToolResult:
        return _text(
            calculators.loan_affordability,
            monthly_net_income,
            existing_monthly_emis,
            annual_rate_pct,
            tenure_months,
            max_foir_pct,
        )

    def get_client_profile() -> CallToolResult:
        return _text(lambda: profile_view(load_client(state_dir)))

    def list_debts() -> CallToolResult:
        return _text(lambda: debts_view(load_client(state_dir)))

    def list_transactions(
        category: Annotated[
            str | None,
            Field(description="Category to match exactly, case-insensitive. Omit for all."),
        ] = None,
        from_date: Annotated[
            str | None,
            Field(description="Earliest date to include, YYYY-MM-DD. Omit for no limit."),
        ] = None,
        to_date: Annotated[
            str | None, Field(description="Latest date to include, YYYY-MM-DD. Omit for no limit.")
        ] = None,
        limit: Annotated[
            int,
            Field(
                description="Most transactions to list; totals still cover every match.",
                ge=1,
                le=MAX_TRANSACTIONS_LIMIT,
            ),
        ] = 50,
    ) -> CallToolResult:
        return _text(
            lambda: transactions_view(load_client(state_dir), category, from_date, to_date, limit)
        )

    def add(
        values: Annotated[
            list[Number],
            Field(
                description="The numbers to add, 2 to 100.",
                min_length=arithmetic.MIN_TERMS,
                max_length=arithmetic.MAX_TERMS,
            ),
        ],
    ) -> CallToolResult:
        return _text(arithmetic.add, values)

    def subtract(
        a: Annotated[
            float, Field(description="The number to subtract from.", ge=-MAX_RUPEES, le=MAX_RUPEES)
        ],
        b: Annotated[
            float, Field(description="The number to subtract.", ge=-MAX_RUPEES, le=MAX_RUPEES)
        ],
    ) -> CallToolResult:
        return _text(arithmetic.subtract, a, b)

    def multiply(
        values: Annotated[
            list[Number],
            Field(
                description="The numbers to multiply, 2 to 100.",
                min_length=arithmetic.MIN_TERMS,
                max_length=arithmetic.MAX_TERMS,
            ),
        ],
    ) -> CallToolResult:
        return _text(arithmetic.multiply, values)

    def divide(
        a: Annotated[
            float, Field(description="The number to divide.", ge=-MAX_RUPEES, le=MAX_RUPEES)
        ],
        b: Annotated[
            float,
            Field(description="The number to divide by; not 0.", ge=-MAX_RUPEES, le=MAX_RUPEES),
        ],
    ) -> CallToolResult:
        return _text(arithmetic.divide, a, b)

    def percent_of(
        value: Annotated[
            float,
            Field(description="The number to take a percentage of.", ge=-MAX_RUPEES, le=MAX_RUPEES),
        ],
        percent: Annotated[
            float,
            Field(description="The percentage (18 means 18%).", ge=-MAX_RUPEES, le=MAX_RUPEES),
        ],
    ) -> CallToolResult:
        return _text(arithmetic.percent_of, value, percent)

    def percent_change(
        from_value: Annotated[
            float, Field(description="The starting number; not 0.", ge=-MAX_RUPEES, le=MAX_RUPEES)
        ],
        to_value: Annotated[
            float, Field(description="The new number.", ge=-MAX_RUPEES, le=MAX_RUPEES)
        ],
    ) -> CallToolResult:
        return _text(arithmetic.percent_change, from_value, to_value)

    def round_(
        value: Annotated[
            float, Field(description="The number to round.", ge=-MAX_RUPEES, le=MAX_RUPEES)
        ],
        places: Annotated[
            int,
            Field(
                description="Decimal places to keep: 2 is paise, 0 whole rupees, -3 the nearest "
                "thousand, -5 the nearest lakh.",
                ge=arithmetic.MIN_PLACES,
                le=arithmetic.MAX_PLACES,
            ),
        ] = 2,
    ) -> CallToolResult:
        return _text(arithmetic.round_number, value, places)

    def reference_rates() -> CallToolResult:
        return _text(reference.reference_rates, rates)

    tools: list[tuple[Callable[..., CallToolResult], str]] = [
        (
            calculate_emi,
            "Monthly EMI on a reducing-balance loan, with total interest and total payable. "
            "Rupees, percent per year and months; the last payment absorbs paise rounding so "
            "the loan closes at exactly ₹0.00.",
        ),
        (
            amortization_schedule,
            "Loan amortisation schedule: opening balance, principal paid, interest paid and "
            "closing balance per year (default) or per month. Rupees, percent per year and "
            "months; at most 60 rows per call, so page with start_period.",
        ),
        (
            prepayment_impact,
            "Effect of a one-time part-prepayment on a reducing-balance loan: the new EMI or new "
            "tenure, and the interest saved. Rupees, percent per year and months.",
        ),
        (
            debt_payoff_plan,
            "Pay off several debts from one fixed monthly budget, simulated month by month: "
            "payoff order, the month each debt clears, months to debt-free and total interest. "
            "Each month interest accrues at annual/12 on the opening balance, minimums are paid, "
            "and the rest goes to the target debt; stops at 600 months.",
        ),
        (
            sip_future_value,
            "Future value of a monthly SIP, with total invested and gains. Contributions at the "
            "start of each month (annuity due), returns compounded monthly at annual/12, and the "
            "monthly amount stepped up every 12 months. An optional lump sum invested at the "
            "start grows at the same rate; its value and the SIP's are then reported separately.",
        ),
        (
            fd_maturity,
            "Maturity amount and interest earned on a cumulative fixed deposit. Rupees and "
            "percent per year; a part period at the end earns simple interest.",
        ),
        (
            inflation_adjusted_value,
            "Future cost of an amount today after inflation, or the present value of a future "
            "amount. Rupees, percent per year and whole years, compounded yearly.",
        ),
        (
            loan_affordability,
            "Largest new EMI that keeps total EMIs within the FOIR limit of monthly net income, "
            "and the largest loan that EMI supports. Rupees, percent per year and months; zero "
            "if existing EMIs already reach the limit.",
        ),
        (
            get_client_profile,
            "The current client's profile as recorded (for example name, age, city, dependents, "
            "income in rupees, notes). Says client_on_file false if there is no client.",
        ),
        (
            list_debts,
            "The current client's debts: balance in rupees, interest rate in percent per year and "
            "minimum monthly payment in rupees. Says client_on_file false if there is no client.",
        ),
        (
            list_transactions,
            "The current client's transactions, oldest first, filtered by category and an "
            "inclusive date range, with debit and credit totals over all matches. Amounts in "
            "rupees; says client_on_file false if there is no client.",
        ),
        (
            add,
            "The sum of two or more numbers, in exact decimal arithmetic: rupees, months, counts "
            "or any other unit. Returns sum, rounded half-up to 2 decimals.",
        ),
        (
            subtract,
            "The difference a minus b, in exact decimal arithmetic, for any unit. Returns "
            "difference, rounded half-up to 2 decimals.",
        ),
        (
            multiply,
            "The product of two or more numbers, in exact decimal arithmetic: for example a "
            "monthly amount times a number of months. Returns product, rounded half-up to 2 "
            "decimals.",
        ),
        (
            divide,
            "The quotient a divided by b, in exact decimal arithmetic: for example an amount split "
            "over a number of months. Returns quotient, rounded half-up to 2 decimals; b must not "
            "be 0.",
        ),
        (
            percent_of,
            "What a percentage of a number comes to, value × percent / 100: 18 percent of 50,000 "
            "is 9,000. Returns amount, rounded half-up to 2 decimals.",
        ),
        (
            percent_change,
            "The change from from_value to to_value, as a difference and as a percent of "
            "from_value: 50,000 to 60,000 is a change of 10,000 and 20 percent. Returns change "
            "and change_pct, both rounded half-up to 2 decimals; from_value must not be 0.",
        ),
    ]
    for fn, description in tools:
        server.register(fn, description)
    server.register(
        round_,
        "A number rounded half-up, halves away from zero, to a given number of decimal places, "
        "2 by default (paise): 23,120.456 is 23,120.46 at 2 places and 23,000 at -3. Returns "
        "rounded.",
        name="round",
    )
    server.register(
        reference_rates,
        "Documented Indian market assumptions: State Bank of India's one-year fixed deposit and "
        "savings account rates, the PPF rate for the current quarter, CPI inflation, the RBI "
        "repo rate, and long-run equity and debt index returns. Each has a value in percent, "
        "its source (organisation and URL) and the date it applies to; they are a dated "
        "snapshot, not live rates.",
    )

    @server.custom_route("/health", methods=["GET"])
    async def health(request: Request) -> Response:
        return JSONResponse({"status": "ok"})

    return server
