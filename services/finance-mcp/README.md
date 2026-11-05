# finance-mcp

An MCP tool server for Indian personal finance. Every agent harness on the platform (Hermes
Agent, LangGraph, Google ADK, the OpenAI Agents SDK and the plain loop) gets its task tools from
this one server. That way each harness sees the same tool names, descriptions and input schemas,
and a harness comparison does not end up measuring a gap between tool sets.

Tasks put the agent in the role of a personal-finance advisor for a client in India. The tools do
the arithmetic, and the agent does the judgment and writes the response. Graders compare tool
outputs and final answers exactly, so every tool is deterministic. The same inputs and the same
`client.json` give byte-identical output: there is no clock, no randomness and no network.

## Tools

| Tool | What it returns |
| --- | --- |
| `calculate_emi` | EMI on a reducing-balance loan, the final payment, total interest and total payable. |
| `amortization_schedule` | Yearly (default) or monthly rows of opening balance, principal paid, interest paid and closing balance, 60 rows per page. |
| `prepayment_impact` | The effect of a one-time part-prepayment: new EMI or new tenure, months saved and interest saved. |
| `debt_payoff_plan` | An avalanche or snowball simulation: payoff order, the month each debt clears, months to debt-free and total interest. |
| `sip_future_value` | SIP corpus, total invested and gains, with an optional yearly step-up and an optional lump sum invested at the start. |
| `fd_maturity` | Maturity amount and interest earned on a cumulative fixed deposit. |
| `inflation_adjusted_value` | The future cost of an amount today, or the present value of a future amount. |
| `loan_affordability` | Largest new EMI under a FOIR limit, and the largest loan that EMI supports. |
| `get_client_profile` | The client's profile, exactly as written in `client.json`. |
| `list_debts` | The client's debts, with total balance and total minimum payments. |
| `list_transactions` | The client's transactions, filtered by category and date range, with debit and credit totals. |
| `add` | The sum of 2 to 100 numbers. |
| `subtract` | `a` minus `b`. |
| `multiply` | The product of 2 to 100 numbers. |
| `divide` | `a` divided by `b`; an error when `b` is 0. |
| `percent_of` | `percent` percent of `value`: `value × percent / 100`. |
| `percent_change` | The change from `from_value` to `to_value`, as a difference and as a percent of `from_value`. |
| `round` | A number rounded half-up to `places` decimals (default 2; negative places round to tens, thousands, lakhs). |
| `reference_rates` | Documented Indian market assumptions (FD, savings, PPF, CPI inflation, repo rate, long-run equity and debt returns), each with its value, unit, source and date. |

All 19 tools are read-only (`readOnlyHint: true`). The full manifest the agents see is in
`tests/snapshots/tools_manifest.json`, and a test fails on any change to it.

The last seven, the arithmetic tools, were added on 5 Nov (D54, server version 0.3.0), so that
every figure an agent writes can come from a tool result and the agent never does its own sums.
The platform's number-provenance check counts a figure as supported only when a tool result, the
client file or a user message holds it, and an arithmetic tool's result only when every number it
was given is supported in turn (D56); on 4 Nov most Hermes failures of that check were sums
written in prose. The first eleven tools are unchanged.

`reference_rates` was added on 5 Nov too (D58, server version 0.4.0), so that a rate an agent
volunteers (an FD rate, inflation, an equity return) has a documented source and date, and an
invented one still fails the provenance check. Its values are in
`src/finance_mcp/reference_rates.json` (see below). The platform's check also lets an
arithmetic input be a unit fact (12 months, 365 days, 100 for a percentage) without a source.

## Conventions

### Units, money and rounding

- **Units.** Money is in rupees, given as plain JSON numbers. Rates are in percent per year, so
  `9` means 9%. Tenures are in months, except SIP, FD and inflation, which take years.
- **Decimal arithmetic.** Calculations use `decimal.Decimal` with 50 significant digits and
  `ROUND_HALF_UP`. A float input is converted through its shortest repr, so `9.1` becomes
  exactly `9.1`.
- **Money inputs** are rounded half-up to paise on entry. **Money outputs** have exactly two
  decimals (`1000.10`, not `1000.1`).
- **Formatted strings.** Every money output `x` also has `x_formatted`, in Indian digit grouping
  with the rupee sign: `₹12,34,567.89`, `₹999.50`, `₹0.00`. A negative value puts the sign
  first: `-₹1,500.00`. Zero is never shown as negative.
- **Words.** Headline totals also get `x_words`, but only when the absolute value is at least
  ₹1,00,000. Examples are `12.35 lakh`, `1.2 crore` and `12,345.68 crore`. The figure is
  rounded half-up to 2 decimals, and trailing zeros are dropped. A value that rounds to 100
  lakh is shown in crore. Schedule rows and transaction rows carry no words.
- **Percent outputs** (`current_foir_pct`, `cumulative_inflation_pct`) are rounded half-up to
  2 decimals.

### Loans: `calculate_emi`, `amortization_schedule`, `prepayment_impact`

- **EMI.** The monthly rate is `r = annual_rate_pct / 12 / 100`. The EMI is
  `P·r·(1+r)^n / ((1+r)^n − 1)`, rounded half-up to paise. At a 0% rate it is `P / n`.
- **Monthly interest** is `round2(balance × annual_rate_pct / 1200)`. Multiplying first keeps
  this rounding identical to exact rational arithmetic.
- **The schedule** pays the EMI in months 1 to n−1. Month n pays the whole remaining balance
  plus its interest, so the loan closes at exactly ₹0.00.
  - `final_payment` reports that last amount. `amortization_schedule` also sets
    `final_payment_adjusted` and adds a `note` that says what happened.
  - `total_interest` and `total_payable` are sums over this schedule, not EMI × n. At a 0% rate
    that gives interest of exactly ₹0.00. For ₹10,00,000 at 9% over 240 months, the EMI is
    ₹8,997.26, the final payment ₹8,996.98, and total interest ₹11,59,342.12.
- **Unschedulable loans.** Some loans cannot be scheduled sensibly in whole paise, and the tool
  rejects them with an error instead of returning absurd rows. This happens when:
  - the EMI rounds to ₹0.00;
  - some month's EMI does not cover that month's interest;
  - the balance clears before the last month;
  - the final payment would be more than twice the EMI.

  Realistic loans never hit these limits. Tiny principals over long tenures do (₹10 over 600
  months), and so do extreme rate and tenure pairs (100% a year for 50 years).
- **Yearly rows** cover months 1–12, 13–24 and so on. The last row may be a partial year; its
  `first_month` and `last_month` say which months it covers. Each response has at most 60
  rows. Ask for the next page by passing `start_period` = `next_start_period` (which is `null`
  on the last page). Totals always cover the whole loan.
- **Prepayment.** The current loan is the paise schedule of `outstanding_principal` over
  `remaining_months`. The prepayment must be less than the outstanding amount.
  - `reduce_emi` recomputes the EMI on the reduced principal over the same months.
  - `reduce_tenure` keeps the current EMI and pays it until the balance plus interest is at
    most one EMI. That month pays exactly what is due. The tenure never exceeds
    `remaining_months`.
  - `interest_saved` is the current schedule's interest minus the new schedule's interest. The
    prepayment itself is not counted.

### `debt_payoff_plan`

- The simulation runs month by month, for at most 600 months. Each month has three steps:
  1. every unpaid debt accrues `round2(balance × annual_rate_pct / 1200)` on its opening
     balance;
  2. every unpaid debt is paid `min(minimum_payment, balance)`;
  3. what is left of `monthly_budget` goes to unpaid debts in priority order. Each debt takes
     up to its balance, so a cleared target passes the rest to the next debt in the same
     month.
- The budget is the same every month, so a cleared debt's minimum becomes surplus from then
  on: freed minimums roll over.
- **Priority** is fixed at the start. Avalanche puts the highest `annual_rate_pct` first.
  Snowball puts the smallest starting balance first. Ties keep input order.
- `payoff_order` lists debts in the order they actually cleared. Ties within a month follow
  priority order. A debt can clear on its minimum before the target does.
- A budget below the sum of minimums is an error. A budget equal to the sum is allowed.
- If the debts are not cleared within 600 months, the result has `debt_free: false`,
  `months_to_debt_free: null`, `months_simulated: 600`, and each debt's `remaining_balance`.

### `sip_future_value`

- Contributions are made at the start of each month (annuity due). Each month, the
  contribution is added first, then the month's growth `1 + annual/12/100` applies.
- In year y, counting from 0, the monthly amount is
  `round2(monthly_investment × (1 + annual_step_up_pct/100)^y)`.
- The corpus is carried unrounded and rounded once at the end. Without a step-up, this is the
  closed form `P·((1+i)^n − 1)/i·(1+i)`. For ₹10,000 a month at 12% for 10 years, that gives
  ₹23,23,390.76.
- **Lump sum (optional, since 4 Nov).** `lump_sum` is invested once at the start and grows at
  the same monthly rate: `L·(1+i)^n` with n = 12 × years, rounded once. With a lump sum above
  ₹0.00 the result adds `lump_sum`, `lump_sum_value` (what it grew to) and `sip_value` (the
  monthly part, exactly the corpus the same call gives without a lump sum); `corpus` is
  `lump_sum_value + sip_value`, so the parts add up exactly, and `total_invested` includes the
  lump sum. Without one, or with 0, the result is byte-identical to before the parameter
  existed. ₹1,00,000 up front plus ₹10,000 a month at 12% for 10 years: the lump sum grows to
  ₹3,30,038.69 and the corpus is ₹26,53,429.45.

### `fd_maturity`

- Compounding is `quarterly` by default (the usual Indian bank convention); `monthly` and
  `annually` are also accepted. The deposit is cumulative: interest is paid at maturity, and no
  TDS is deducted.
- `years` may be fractional. With m compounding periods a year:
  - k = floor(years × m) full periods compound;
  - the part period f = years × m − k earns simple interest;
  - maturity = `P·(1 + R/(100m))^k · (1 + f·R/(100m))`, rounded at the end.

  So 1.5 years quarterly is 6 full quarters, and 1.1 years quarterly is 4 quarters plus 0.4 of
  a quarter.

### `inflation_adjusted_value`

- Inflation compounds once a year over whole years.
- `future_cost` = amount × (1+i)^years. `present_value` = amount / (1+i)^years.

### `loan_affordability` (FOIR)

- FOIR is fixed obligations as a share of income. The limit is
  `round2(monthly_net_income × max_foir_pct / 100)`, where `max_foir_pct` defaults to 50.
- `max_new_emi` is the limit minus existing EMIs, floored at zero. It is zero, with
  `eligible: false`, when existing EMIs already reach or exceed the limit.
- `max_loan_amount` is the principal whose exact EMI equals `max_new_emi`, rounded half-up. At a
  0% rate it is EMI × n.

### Arithmetic: `add`, `subtract`, `multiply`, `divide`, `percent_of`, `percent_change`, `round`

- **Any unit.** The numbers may be rupees, months, counts or percentages; the tools do not know
  which. So inputs are used exactly as given (a float through its shortest repr, as everywhere),
  never rounded to paise on entry, since an input may be a rate.
- **Bounds.** Every input and every result lies within -10^12 to 10^12, the ceiling every money
  input has. A result outside it is an error (`the product is outside -10^12 to 10^12`), checked
  before rounding, so a product of 100 large numbers is refused rather than crashing.
- **Results** are rounded half-up to 2 decimals (`{"sum":23120.00}`), like money outputs, and
  computed in exact Decimal first: `0.1 + 0.2` is `0.30`. They are plain numbers: no
  `_formatted` and no `_words`, because the unit is unknown. Zero is never `-0.00`.
- **Results never echo the inputs.** A result holds only what the tool worked out, so the
  provenance check finds the answer there, not a number the agent passed in.
- **One key each:** `sum`, `difference`, `product`, `quotient`, `amount` (`percent_of`), and
  `change` plus `change_pct` (`percent_change`), `rounded` (`round`).
- `add` and `multiply` take 2 to 100 numbers: an empty or one-item list is an error.
- `divide` with `b` = 0 is an error: `cannot divide by zero: b is 0`.
- `percent_change`: `change = to_value − from_value` and `change_pct = change / |from_value| ×
  100`, so a rise is positive even from a negative start. A `from_value` of 0 is an error.
- `round`: half-up, so halves go away from zero (`2.345` → `2.35`, `-2.345` → `-2.35`).
  `places` is -7 to 10, default 2; the result has exactly `places` decimals, or none when
  `places` ≤ 0 (`23120.456` at -3 is `23000`).
- **Precision is 2 decimals.** A small ratio loses digits (`divide(9, 1200)` is `0.01`). For
  percentages use `percent_of` and `percent_change`, which work in percent.

### `reference_rates`

- **One file.** The values live in `src/finance_mcp/reference_rates.json`: for each key a
  `name`, `value`, `unit`, `as_of` date, `as_of_means` (what the date is: when a rate took
  effect, the month an inflation figure measures, the end of a return period), `source`
  (`organisation`, `url`) and `evidence`, the verbatim text the value was read from and when.
  The tool serves everything but `evidence`, plus the file's `compiled_on` date and `note`.
- **Proposed, then approved.** The values were gathered on 5 Nov 2026 and are proposed for
  Rishi's approval before any run uses them. Edit the file to change one.
- **A snapshot, not live rates.** The server has no network; a value stays what the file says
  until someone edits it. Each `as_of` says how old it is.
- **Numbers are values only.** No text field holds a standalone number (names say "three
  crore", "Nifty50"), and the provenance check skips dates and URLs, so the result supports
  exactly its rates and nothing else. A test checks this.
- **An edit is a new server version.** The file is checked at startup (a missing field, a
  non-number value, an `as_of` after `compiled_on` or a non-https URL fails it), and
  `tests/test_reference.py` pins the served bytes to the server version. Change a value, bump
  `__version__` (and `pyproject.toml`), pin the new bytes, and the API's toolset hash changes
  with it, so a trial's toolset says which values it was shown.
- **No arguments.** It returns every rate at once, about 3,400 characters.

## What a result looks like

- **Text only.** Each result is one text block of canonical JSON:
  - keys appear in the order the tool builds them;
  - separators are compact, with no whitespace;
  - text is UTF-8 (`₹`, not an escape);
  - money is written as exact decimals.

  There is no `structuredContent` and no `outputSchema`. Harnesses differ in which of the two
  channels they show the model, so one channel keeps every harness on the same bytes.
- **Errors** come back as MCP error results (`isError: true`) with one short line, never a
  traceback. Examples:
  - `Error executing tool calculate_emi: invalid arguments: principal: Input should be greater than or equal to 1`
  - `Error executing tool debt_payoff_plan: monthly_budget ₹100.00 is below the sum of minimum payments ₹500.00`
  - `Error executing tool calculate_emi: unknown argument(s) rate; it takes principal, annual_rate_pct, tenure_months`

  Unknown arguments are rejected, so a misspelt optional parameter cannot be silently ignored.
- **Input schemas are flat and self-contained.** Harnesses rewrite schemas: LangGraph inlines
  `$ref` and strips `title`, and Hermes collapses nullable `anyOf` and always adds `required`.
  To leave them nothing to rewrite, every `inputSchema` follows these rules:
  - no `$ref`, `$defs`, `title` or `anyOf`;
  - an explicit `type` and a `description` on every property;
  - every object has `properties`, `required` and `additionalProperties: false`;
  - nested objects, such as a debt in `debt_payoff_plan`, are inlined.

  A test checks all of this on the snapshot.

## `client.json`

Each trial's client lives in `<state dir>/client.json`.

- The file is read and validated on every call, so a runner can rewrite it between trials.
- If there is no state directory or no file, the client tools return
  `{"client_on_file":false,"message":"No client on file."}`. That is a normal result, not an
  error.
- A file that exists but is invalid is a tool error that names the first bad field. For
  example: `client.json is invalid: debts[0].balance: Field required (and 2 more)`.
- Parsing is strict. Duplicate keys, `NaN` and `Infinity` are rejected, and so is any unknown
  field outside `profile`.

The JSON Schema is `schemas/client.schema.json`, generated from the models in
`src/finance_mcp/client_data.py`. The main fields:

| Field | Type | Rules |
| --- | --- | --- |
| `schema_version` | `1` | Required. |
| `synthetic` | bool | Optional, default `false`. Set `true` for invented data. |
| `profile` | object | Required. Free-form, but `name` (string) is required. It is echoed exactly as written, key order and number digits included. Suggested keys: `age`, `city`, `occupation`, `monthly_net_income`, `dependents`, `goals`, `notes`. |
| `debts[]` | object | Fields: `name` (unique, 1–60 chars), `balance` (rupees ≥ 0, ≤ 2 decimals), `annual_rate_pct` (0–100), `minimum_payment` (rupees ≥ 0). Optional: `kind` (lower_snake_case), `lender`, `remaining_months` (1–600). |
| `transactions[]` | object | Fields: `id` (unique), `date` (`YYYY-MM-DD`, a real date), `description`, `category` (lower_snake_case, for example `groceries`), `direction` (`debit` or `credit`), `amount` (rupees > 0, ≤ 2 decimals). |

`list_transactions` filters and sorts like this:

- `category` is an exact match after trimming and lower-casing.
- `from_date` and `to_date` are inclusive and compared as ISO strings.
- Matches are sorted by date, with ties kept in file order.
- `limit` (default 50, at most 500) caps the rows listed, but `total_debits`, `total_credits`
  and `net` cover every match.
- `truncated` says whether rows were cut, and `available_categories` lists every category in
  the file.

`examples/client.example.json` is a **synthetic** client, an invented Pune-based QA engineer
with three debts and a month of transactions. It is marked `"synthetic": true`, and her
profile notes say so.

To regenerate the schema after changing the models:
`uv run python -m finance_mcp.client_data > schemas/client.schema.json`.

## Run

```sh
uv sync
uv run finance-mcp --transport stdio --state-dir /path/to/trial/state
uv run finance-mcp --transport http --port 8090 --state-dir /path/to/trial/state   # serves /mcp
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--transport` | none (required) | `stdio` or `http` (streamable HTTP at `/mcp`). The transport decision is still open, so neither is preferred. |
| `--host` | `127.0.0.1` | HTTP bind address. Use `0.0.0.0` in a container. |
| `--port` | `8090` | HTTP port. |
| `--state-dir` | `$FINANCE_STATE_DIR` | Directory holding `client.json`. If unset, the client tools report no client. If set but missing, the server warns at startup and checks again on every call. |

- **HTTP mode** is stateless and returns plain JSON responses, not SSE. No session is kept,
  which suits a server whose only state is a file it re-reads. `GET /health` returns
  `{"status":"ok"}`.
- **Host checks.** When bound to `127.0.0.1`, the SDK's DNS-rebinding protection accepts only
  localhost Host headers. Bound to `0.0.0.0`, it accepts any.
- **Logs** go to stderr only. On stdio, stdout carries the protocol and nothing else.

### Protocol versions

The server uses `mcp` 2.3.0, the latest stable release (uploaded 2 Oct 2026). It speaks these
protocol versions:

- **Through the `initialize` handshake:** `2024-11-05`, `2025-03-26`, `2025-06-18`,
  `2025-11-25`. The handshake echoes a supported version back. For an unknown version it
  counter-offers `2025-11-25`.
- **Through `server/discover`:** `2026-07-28`, the stateless per-request protocol. The 2.3.0
  client's default `mode="auto"` picks it.

Tests cover both clients the harnesses use:

| Client | Used by | Protocol it negotiates | Transports tested |
| --- | --- | --- | --- |
| `mcp` 2.3.0 | Hermes, the OpenAI Agents SDK | `2025-11-25` through `ClientSession` + `initialize()`, as Hermes connects; `2026-07-28` with `Client(mode="auto")` | stdio, HTTP |
| `mcp` 1.30.0 | langchain-mcp-adapters 0.3.2, which pins `mcp<2` | `2025-11-25` | stdio, HTTP |

Every client gets the same result bytes. The 1.30.0 client also sees the manifest snapshot
exactly, key order included. One quirk: in the 2026-07-28 era, the SDK's wire model moves
`type` to the front of the root `inputSchema`. The content is identical; only that key order
differs.

### Using it from a harness

Point the harness's MCP client at `finance-mcp --transport stdio --state-dir <trial>/state`, or
at `http://<host>:8090/mcp`. Hermes shows the tools to the model as
`mcp__<server-name>__<tool>` and wraps their results as untrusted. Its notes are in
`docs/research/hermes/custom_tools.md`.

## Docker

```sh
docker build -t agent-evals/finance-mcp:dev .
docker run --rm -p 127.0.0.1:8090:8090 -v /path/to/state:/trial/state:ro agent-evals/finance-mcp:dev
docker run -i --rm -v /path/to/state:/trial/state:ro agent-evals/finance-mcp:dev \
  finance-mcp --transport stdio --state-dir /trial/state
```

The image uses `python:3.14-slim` (pinned by digest) and `uv` 0.13.6, and runs as uid 10001.
It works with a read-only root filesystem and all capabilities dropped. By default it serves
HTTP on 8090 with `--state-dir /trial/state`, and its health check calls `GET /health` from
Python.

## Tests and lint

```sh
uv run pytest                  # ~17 s; starts real stdio and HTTP servers as subprocesses
uv run ruff check .            # uses the repo-root ruff.toml
uv run ruff format --check .
FINANCE_MCP_UPDATE_SNAPSHOT=1 uv run pytest tests/test_mcp.py -k snapshot   # after a deliberate tool change
```

- **Calculator tests** check values against an independent reference written with
  `fractions.Fraction`. They also pin widely published figures such as the ₹10 lakh / 9% /
  20-year EMI.
- **Independent tests** (`tests/test_calculators_independent.py`, about 2,000 cases in a few
  seconds): a second implementation of all eight calculators, written from the conventions
  above with the standard library only and sharing no code with the server, is compared field
  by field, key order included, over a grid of inputs for each calculator, refusals included.
  Where it can, it is written differently (the SIP grows a year at a time in closed form; the
  server goes month by month). Golden literals pin published figures (the ₹10 lakh and ₹50 lakh
  EMIs, ₹10,000 and ₹5,000 SIPs, a ₹1 lakh FD, ₹1 lakh at 6% inflation) and a debt payoff
  worked by hand. Turning the SIP into an annuity-immediate fails 145 of them.
- **Arithmetic tests** (`tests/test_arithmetic.py`, about 830 cases): every pair from a grid of
  21 values (zero, negatives, floats such as 0.1 and 0.005, paise boundaries, ±10^12) through
  each two-number tool, and each value at every `places` through `round`, against an exact
  `fractions.Fraction` reference that rounds half-up once and refuses out-of-range results; plus
  the edge cases: empty and one-item lists, division by zero, a zero start for
  `percent_change`, non-numbers, NaN and infinity, and a product of 100 numbers of 10^12.
- **Reference-rate tests** (`tests/test_reference.py`): the result's shape, that its only
  numbers are the rates, that a malformed edit is refused at startup, and the served bytes
  pinned to the server version.
- **Compatibility tests.** `tests/test_compat_mcp1.py` runs an `mcp` 1.30.0 client from its own
  locked environment in `tests/compat/mcp1/`, because 1.x and 2.x cannot share one
  environment. `uv` builds that environment on first use, which needs network access once; the
  test is skipped if `uv` is not on PATH.
- No test calls an LLM.

## Out of scope, on purpose

- **Income tax:** the rules change every year.
- **Stock or fund recommendations.** The tools compute; the agent advises.
- **Dates relative to "today".** Any date logic takes dates as inputs.
- **Write tools.** All tools are read-only for now; state-changing tools will come with task
  design. To add one:
  - register a function in `create_server` with `READ_ONLY` replaced by
    `ToolAnnotations(read_only_hint=False, destructive_hint=..., idempotent_hint=...)`;
  - write only inside the state directory: a temp file, then an atomic rename;
  - give it a deterministic result (no timestamps or generated ids, or ids derived from the
    inputs);
  - add it to `SAMPLE_CALLS`, and regenerate and review the manifest snapshot.

  Graders can then check the state file after the trial.
