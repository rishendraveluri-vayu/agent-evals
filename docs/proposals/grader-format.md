# Proposal: the grader format (SP4) — DRAFT for Rishi

Status: **draft, 4 Nov 2026**. The task format is **[Rishi designs]**. This is what the grader
framework (`graders/`, package `evals_graders`) reads today, built so the evals can start; every
choice below is open to change. The machine-readable form is
`graders/src/evals_graders/grader-spec.schema.json`. It follows decisions already made: D1
(graders in Python), D2 (workers claim and report over HTTP), R10.2 (adapters never judge), R14
(grading is its own step, so a grader fix re-grades without re-running), and review notes 20, 21
and 31.

## In one paragraph

A task's `task.json` has `graders: [...]`. Each grader is `{id, type, required, ...}`. A grader
reads the trial's `out/` folder (the final answer and transcript in `result.json`, tool calls in
the `execute_tool` spans of `trace.jsonl`, platform checks in `checks.json`) and returns a verdict
with quoted evidence. The task passes when every `required` grader passes. Aggregating across
trials is SP6's job; the framework records each grade and the task's outcome per trial.

## A grader spec

| Field | Meaning |
| --- | --- |
| `id` | Unique within the task: lowercase letters, digits, `_.-`. |
| `type` | One of the nine types below. |
| `required` | Counts towards the task's pass. **Default `true`**, so leaving it out is the strict choice. |
| `description` | Optional words for the UI. |

Unknown fields are refused, so a typo (`tolerence`) is an `error` grade instead of a silently
weaker grader.

### Types

| Type | Fields | Passes when |
| --- | --- | --- |
| `number` | `expected`: a number, or `{from_tool, field, call?}`; `tolerance`: `{abs?, rel?}` (default `{abs: 1}`); `target` (default `final_answer`); `match`: `amount` (default) or `any` | An amount in the target is within tolerance of the expected value. With `from_tool`, the expected value is what that tool returned at `field` (`total_interest`, `debts[0].interest_paid`), from `call` `any` (default), `first` or `last` call. If the tool was never called, it **fails** (note 21: an EMI worked out in the agent's head has no tool behind it). |
| `tool_called` | `tool`; `args` (a subset to match); `tolerance` for numeric args; `min_calls` (default 1); `max_calls`; `successful` | At least `min_calls` calls match `args`, and the tool was called at most `max_calls` times (with any args). |
| `tool_not_called` | `tool`; `args` | No call of the tool (with those args, when given). |
| `regex_present` / `regex_absent` | `pattern` (Python regex); `target`; `case_sensitive` (default false) | The pattern is (or is not) in the target. |
| `end_state` | `states`: a list of contract v2 end states | The trial ended in one of them. |
| `provenance` | `max_unsupported` (default 0) | `checks.json`'s number-provenance check found at most that many amounts with no tool result behind them (note 31). `not_applicable` when there is no `checks.json`. |
| `unit_test` | `file` (default `grader.py`, next to `task.json`); `function` (default `grade`); `timeout_s` (default 10, max 120) | The task's own `grade(trial)` says so. This is the brief's "unit tests". |
| `judge` | `rubric` (`{id, version}` or a path); `criteria` (a list); `model`; `reference` | **Reserved.** Returns `not_implemented` until the rubric exists. |

**Targets** (`number`, `regex_*`): `final_answer` is the agent's last visible reply;
`agent_messages` is each visible reply on its own (a conversation's earlier answers count);
`all_agent_text` adds the arguments of every tool call, i.e. everything the agent wrote, seen or
not (to catch, say, a PAN sent to a tool).

**Amounts** (`number`, `match: amount`): a number with a rupee marker (₹, Rs, Rs., INR, rupees),
a lakh or crore scale (₹4.41 lakh = 4,41,000), or digit grouping, Indian (₹1,01,341) or Western
(101,341). `match: any` also takes bare numbers, such as the 28 in "28 months". A tolerance with
both `abs` and `rel` uses the looser.

**Tool names and results are normalised**, so one spec works on every harness: Hermes's
`mcp__finance__calculate_emi` is `calculate_emi`, and its `{"result": "<json>"}` wrapper and
Google ADK's MCP `{"content": [{"type": "text", ...}]}` wrapper are peeled before `field` is read.

**`unit_test`.** `grade(trial)` gets plain JSON: `end_state`, `final_answer`, `transcript`,
`agent_messages`, `tool_calls` (each with `name`, `raw_name`, `arguments`, `result`,
`result_text`, `is_error`, `span_id`), `checks` and the whole `result`. It returns
`{"verdict": "pass"|"fail"|"not_applicable"|"error", "score"?, "reason"?, "evidence"?}` or
`{"pass": bool, ...}`. It runs in a fresh Python subprocess with an empty folder and environment,
is killed (its whole process group) at the timeout, and cannot open a socket or start a process (a
Python audit hook installed before `grader.py` is imported; audit hooks cannot be removed). A
crash, a timeout or an unusable return value is an `error` grade, never a fail.

### What a grader returns

```json
{"grader_id": "interest", "type": "number", "required": true,
 "verdict": "pass", "score": 1.0,
 "reason": "found ₹1,01,341, within ±1 of 101341.01 (debt_payoff_plan total_interest)",
 "evidence": [
   {"source": "final_answer", "quote": "paying roughly **₹1,01,341** in interest on top of the ₹4.41 lakh you owe."},
   {"source": "tool_result", "span_id": "93d27906ada45365", "tool": "debt_payoff_plan", "field": "total_interest", "quote": "\"total_interest\":101341.01"}],
 "grader_version": "sha256:...", "spec_sha256": "sha256:..."}
```

- `verdict`: `pass`, `fail`, `not_applicable` (nothing to check), `error` (the grader could not
  run: a bad spec, a missing file, a crash, a timeout) or `not_implemented` (the judge).
- `score`: 1 or 0 for the built-in types; a `unit_test` may return a fraction; null without a
  verdict on the agent.
- `evidence`: each item names its `source` and quotes the text it relied on, **verbatim** (the
  tests check every quote is a substring of its source on the real 4 Nov trials). Sources:
  `final_answer`, `agent_message` (with the transcript `index`), `span` (a tool call's arguments,
  with `span_id`), `tool_result` (the tool's own output, unwrapped), `result` (a `result.json`
  field such as `end_state`) and `checks`. A pass that rests on an absence (`tool_not_called`,
  `regex_absent`) has nothing to quote and says so in `reason`.

### The task's outcome

`passed` is true when every required grader passed, false when a required grader failed, and
**null (`incomplete`) otherwise**: a required grader that errored, was not applicable or is the
unbuilt judge leaves the trial undetermined instead of silently counting as a pass or a fail.
A task with no required graders is also `incomplete`.

### Versions

A grade's `grader_version` is `sha256(canonical {"framework": <framework version>, "spec":
<spec_sha256>})`, where `spec_sha256` hashes the spec and, for a `unit_test`, the sha256 of its
grader file. Editing a spec, its grader file or the framework (`evals_graders.FRAMEWORK_VERSION`,
bumped when a change can move a verdict) gives a new version, so old and new grades sit side by
side. The API computes the same hashes (shared test vectors in `graders/tests/hash_vectors.json`).

## Choices for you

1. **`required` defaults to true.** Alternative: make it mandatory in every spec.
2. **`incomplete` outcomes.** A required grader with `error`, `not_applicable` or
   `not_implemented` leaves the task undetermined. Alternatives: treat `not_applicable` as a pass
   (lenient), or every non-pass as a fail (the brief's literal "all required graders passing").
3. **`number` defaults:** `match: amount`, tolerance ±₹1, and `call: any` (any call of the tool
   counts). Agents round: Haiku's own loop wrote "about ₹33,500" for the tool's ₹33,491.54, which
   fails at ±₹1 and passes at ±0.1%. Pick the tolerance per task.
4. **`max_calls` counts every call of the tool**, whatever its arguments (for loops); `min_calls`
   counts calls matching `args`.
5. **`regex_absent` with no answer** is `not_applicable`, since there is nothing to check;
   `end_state` catches the missing answer.
6. **Which graders a re-grade uses** (see `docs/api-contract.md`, Grading): the current
   `tasks/<id>/task.json`, unless the task itself (anything but `graders`, `version` and
   `summary`, or its client file) changed since the trial ran, in which case the trial's own task
   version. A unit_test file is then unavailable and its grade is an `error`.
7. **The `provenance` reader** accepts `checks.json` as `{"number_provenance": {"unsupported":
   [...], "total"?}}` (or `unsupported_count`), or `{"checks": [{"id": "number_provenance",
   ...}]}`, until the adapter library's check lands and fixes one shape.
8. **The judge's interface:** `rubric` as a versioned file like prompts, a list of `criteria`
   (each `{id, text?, required?}`), an optional pinned `model`, and `reference` facts it grades
   against rather than what the agent saw (note 20).

A caution from the real trials: `regex_absent` on `\bOTP\b` failed LangGraph's conversation
because it *warned* the client not to share an OTP. Absence checks on words are blunt; the judge
or a `unit_test` fits such rules better.
