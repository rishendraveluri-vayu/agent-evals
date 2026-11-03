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

`v2/examples/` holds one valid example of each. The tests in `workers/adapterlib/tests/test_contract.py`
check that every example validates and that the mistakes the schemas exist to catch fail.

All schemas use JSON Schema draft 2020-12. Spans follow the OTLP/JSON encoding of
`opentelemetry.proto.trace.v1.Span`: lowercase hex ids, 64-bit integers as decimal strings, and
integer `kind` and `status.code`.
