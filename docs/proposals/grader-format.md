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
| `type` | One of the ten types below. |
| `required` | Counts towards the task's pass. **Default `true`**, so leaving it out is the strict choice. |
| `severity` | Optional: `critical`, `major` or `minor`, how bad a failure of this check is (D10), set by the task's author. It never changes a verdict or the task's outcome. The comparison reads it: B is not called better while its critical failures rose, and the regression list puts critical checks first. Left out, the check is unrated. Adding or changing it changes the spec's hash, so the grader gets a new version and a regrade re-runs it. |
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
| `provenance` | `max_unsupported` (default 0); `target`: `agent_messages` (default, every reply) or `final_answer` | `checks.json`'s number provenance (contract v2 section 12) found at most that many money amounts with no tool result, client-file number or user message behind them (note 31). An arithmetic tool's result counts only when its inputs are supported (D56, framework 0.4.0); for an amount whose only match is one that does not count, the reason gives checks.json's why ("₹23,120 (round's input 23,120 is not supported)"). The evidence quotes each unsupported amount in the reply it came from, and the arithmetic call it matched. `not_applicable` when there is no `checks.json` (trials from before 4 Nov); `error` when the file is not the contract's shape, or when it predates D56 (no `arithmetic`) and an amount rests on an arithmetic result it did not trace while the rest are within the cap (over the cap it fails anyway). |
| `required_tools` | `successful` (default false: with true, a tool whose every call errored counts as not called) | Every tool in the task's own `required_tools` field was called, as `checks.json` records it. The tools are listed once, in `task.json`; the grader takes no tool list, and is an `error` when the task lists none. |
| `unit_test` | `file` (default `grader.py`, next to `task.json`); `function` (default `grade`); `timeout_s` (default 10, max 120) | The task's own `grade(trial)` says so. This is the brief's "unit tests". |
| `judge` | `rubric` (`{id, version}` or a `configs/rubrics/` path); `criteria` (a list of `{id, text?, required?}`); `model`; `reference` | An LLM judge, blind to harness and model, with a verdict and quote per criterion (`evals_graders/judge.py`, below). `not_implemented` until the experiment's judging is approved with a model and a budget. |

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

### Required tools: the task's `required_tools` field or a `tool_called` grader

Two paths check that the agent called a tool. Use the field for a plain "these tools must have
been called" rule, and `tool_called` when the rule needs more.

- **`required_tools` in `task.json`** (contract v2 `task.required_tools`, a list of finance tool
  names). The API copies it into each trial's spec, and the runner records which were called and
  which are missing in `checks.json` after every trial, so the runner report and the trial view
  show it even with no grader. Add a `required_tools` grader to make it count towards the task's
  pass. It knows names only: any call counts (or any successful one, with `successful: true`).
- **A `tool_called` grader** reads the trace's tool calls itself. Use it when the arguments
  matter (`calculate_emi` with `principal: 4500000`), for a minimum or maximum number of calls,
  or for trials that have no `checks.json`. `tool_not_called` is its opposite. One task can use
  both: the field for the record, `tool_called` for an argument check.

Both remove harness prefixes (Hermes's `mcp__finance__`), and on the same trial they agree
(`graders/tests/test_gate_checks.py`).

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
7. **`provenance` and `required_tools` read `checks.json` as the contract fixes it**
   (`contract/v2/checks.schema.json`, since framework 0.2.0). The shapes guessed before the check
   existed are no longer read (assumption A14, superseded); their tests now use `checks.json`
   from real gate runs (`graders/tests/fixtures/gate-20261104/`, and `gate-20261105/` for the
   arithmetic tools, regenerated after D56). Since framework 0.4.0 (D56) the runner traces the
   arithmetic tools' inputs and the grader reads the result; a regrade of a trial whose
   checks.json predates D56 cannot apply it, so an amount resting on an arithmetic result there
   leaves the grade undecided (`error`) unless the trial fails on its other amounts. The
   arithmetic tools exist since 5 Nov, and no trial trace under `runs/` calls one, so those
   regrade as before (`docs/known-limits.md`, Platform checks).
8. **The judge's interface:** `rubric` as a versioned file like prompts, a list of `criteria`
   (each `{id, text?, required?}`), an optional pinned `model`, and `reference` facts it grades
   against rather than what the agent saw (note 20).

A caution from the real trials: `regex_absent` on `\bOTP\b` failed LangGraph's conversation
because it *warned* the client not to share an OTP. Absence checks on words are blunt; the judge
or a `unit_test` fits such rules better.

## The judge (plumbing built 4 Nov night; the rubric and the choices below are Rishi's)

What is built, in `graders/src/evals_graders/judge.py` (framework 0.3.0):

- **No spend without an approval.** The judge calls a model only with the key the API mints once an
  experiment's judging is approved: `POST /api/experiments/:id/judge` with `{model, budget_usd}`
  (R8). The key is capped at the budget and can call only that model. Without one, the grade is
  `not_implemented` and nothing is spent. An approval made after the trials finished applies on
  the next `POST /api/experiments/:id/regrade`.
- **Blind, and the same view as yours.** The judge gets the task summary, the conversation (client
  and assistant turns), the tool calls with bare names, arguments and results, and the spec's
  `reference` facts if any. That is what the blind labelling screen shows you, plus the reference.
  It never gets the harness, the model, the config, the system prompt, timings, cost or another
  grade. A test checks, on the real 4 Nov trial of each of the five harnesses, that no harness or
  model name and no `mcp__` prefix reaches the judge.
- **The prompt:** the system message is the rubric file (its leading `<!-- -->` notes removed),
  then a fixed answer-format paragraph (`OUTPUT_INSTRUCTIONS`): yes or no per criterion, a quote
  copied exactly from the material (empty when the verdict rests on something missing), one
  sentence of reason, as one JSON object. The user message is the material and the criteria.
  No temperature is sent (the Claude 5.5 models reject it); `max_tokens` 8,000 leaves room for the
  model's thinking.
- **Every quote is looked up.** A quote found in the material (whitespace aside) is evidence with
  its source (`agent_message`, `client_message`, `tool_result` or `span`, with the index or span
  id). One not found is kept with `source: "judge"` and `quote_found: false`, and the reason says
  so. The call itself is the last evidence item (`judge_call`: model, rubric sha256, request
  sha256, tokens, cost, latency and the raw reply), so every verdict can be audited.
- **The rubric is part of the grader version**, like a unit_test's file: the API sends it in the
  claim under its `configs/rubrics/` path and hashes it into `spec_sha256`. Editing the rubric
  gives new grades next to the old ones.
- **Test-retest** is a regrade of the same trials: each new answer from the same grader version is
  the next `run_index`, and each grading job keeps the ids of its grades.
- **Tests:** `graders/tests/test_judge.py` and the judge cases in `tests/test_worker.py`, against a
  stub and a local HTTP stand-in for LiteLLM; `fake/judge` on the fake model server for the
  compose path. No test calls a real model.

### Choices for you (the code takes the first option of each until you decide)

9. **The grader's verdict from the criteria:** fail when a required criterion is "no", pass when
   every required one is "yes", otherwise `error` (an "unsure" or a missing answer), which makes
   the task `incomplete`. Alternatives: count "unsure" as a fail, or let the judge answer only yes
   or no (the format paragraph asks for yes or no today; an "unsure" is read only if it comes).
10. **A quote that is not in the material:** kept and flagged, the verdict unchanged. Alternatives:
    turn that criterion into "unsure", or into "no" for a "yes" (stricter: a pass must quote).
11. **What the judge sees:** the same as the labelling screen plus `reference`. Alternatives: no
    tool calls (judge the client's view only), or no reference facts.
12. **The judge model:** none by default; it is whatever you approve per experiment (the
    judge-validation proposal suggests Claude Sonnet 5.5, pinned).
13. **One call per trial for all criteria** (cheaper, criteria can colour each other), or one call
    per criterion (independent, about N criteria times the cost).

