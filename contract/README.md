# Contract

The machine-readable form of the adapter contract (`docs/adapter-contract.md`). The API and the
workers both validate against these schemas, so a change to the contract doc changes them in the
same commit.

| Schema | File it checks | Written by |
| --- | --- | --- |
| `v2/spec.schema.json` | `/trial/spec.json` | runner, from the API |
| `v2/capabilities.schema.json` | `workers/<harness>/capabilities.json` | the probe command, plus hand-declared fields |
| `v2/result.schema.json` | `/trial/out/result.json` | adapter (through the shared library) |
| `v2/span.schema.json` | each line of `/trial/out/trace.jsonl` | adapter, and the runner for proxy spans |
| `v2/runner-report.schema.json` | `/trial/out/runner-report.json` | runner |
| `v2/checks.schema.json` | `/trial/out/checks.json`: number provenance and required tool calls, after every trial | runner (`evals_adapter.checks`) |

`v2/examples/` holds one valid example of each (`checks.json` is the runner's checks on the example trial, whose spec lists `required_tools`), plus `checks-arithmetic.json` (the runner's checks on a small trial with an `add` whose inputs came from `list_debts`, and a `round` of a figure no source holds: the D56 fields `arithmetic`, `rejected` and `match.call`), `spec-client-sim.json` (a simulated-client task) and `runner-report-config-error.json` (the 4 Nov own-loop trial that got Haiku's temperature 400, with the `infra:config_error` label D26 gives it), and `result-sim-error.json` with `runner-report-sim-error.json` (a scripted trial whose simulated client, the fake's `sim-empty` script, replied with no text: `ended_by: sim_error`, label `infra:sim_error`; run straight against the fake, so `proxy_usage` is null). The tests in `workers/adapterlib/tests/test_contract.py`
check that every example validates and that the mistakes the schemas exist to catch fail.

All schemas use JSON Schema draft 2020-12. Spans follow the OTLP/JSON encoding of
`opentelemetry.proto.trace.v1.Span`: lowercase hex ids, 64-bit integers as decimal strings, and
integer `kind` and `status.code`.
