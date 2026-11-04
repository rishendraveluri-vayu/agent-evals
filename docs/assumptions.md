# Assumptions

The brief says to document every assumption. One line each: the assumption, why, and what changes if it's wrong.

| # | Assumption | Why | If wrong |
| --- | --- | --- | --- |
| A1 | One local user: no auth or multi-tenancy | Local one-command run, scope cut | Add auth at the API layer |
| A2 | One machine: no multi-node workers | Local one-command run, scope cut | Workers need remote claim support |
| A3 | Configs and tasks live as files in git, plus a simple form | Versioning comes free, scope cut | Add editors |
| A4 | Polling is enough for run progress | The brief doesn't require live updates | Add SSE or WebSocket |
| A5 | Finance tool conventions: reducing-balance EMI with monthly rate = annual/12; the last EMI absorbs rounding so loans close at exactly ₹0.00; SIP contributions at the start of each month; FDs compound quarterly by default; money rounded half-up to paise | The usual Indian bank and calculator conventions; graders need one exact answer | Expected values in task graders change |
| A6 | Snowball debt payoff orders by starting balance, fixed at the start, ties in input order | The brief and the tool spec left it open | Payoff order in snowball tasks changes |
| A7 | The host's `runs/` folder is writable by uid 1000, the `node` user the API container runs as (as `labels/` already must be) | The API alone stores uploaded trial files there; workers mount nothing | Uploads fail with a 500 and trials go unreported until the folder's owner or mode is fixed |

| A8 | D27's simulator temperature change applies to models that refuse temperature (the API's `MODEL_REJECTS` table, today Haiku 5.5): there the simulator sends none; any other simulator model keeps D22's temperature 0 | D27 amends D22 for Haiku 5.5, the simulator model it names; it does not say other models change | `simTemperature` in `apps/api/src/worker/spec-builder.ts` returns null for every model |
| A9 | The client summary (D27) holds the client file's profile as recorded and its debts with their totals, not its transactions | D27 says "profile and debts"; transactions are long and the agent reads them through a separate tool | The simulator can still contradict a transaction figure the agent quotes; add a transactions section to `clientSummary` |
