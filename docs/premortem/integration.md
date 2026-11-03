# Pre-mortem: integration

L/I: likelihood/impact.

## 1. Verdict

The adapter is designed as a Python class inside one worker, and on Wednesday the second framework will not install beside Hermes, so the contract is rewritten under pressure. Then each harness applies "the same config" differently, so harness numbers measure adapter quirks.

## 2. Breaks

### B1. The harnesses cannot share a Python environment
**Story.** Wed morning, `uv` cannot resolve Hermes plus LangGraph. Half a day goes to images.
**Evidence.** PyPI, checked 3 Nov: Hermes pins `mcp==2.3.0` (audit); `langchain-mcp-adapters` 0.3.2 (6 Aug 2026) needs `mcp<2`; `openai-agents` 0.24.0 (15 Oct) needs `openai>=3`; `google-adk[extensions]` 2.13.0 (23 Oct, the LiteLLM wrapper) needs `openai<3`. Python 3.14 is not the blocker: ADK and the Agents SDK both list it.
**L/I** high/high.
**Test (Tue).** `uv pip compile` each pair.
**Mitigation.** One image per harness. Adapter as container entrypoint plus a stdlib-only shim. 3 h.
**Decision.** Process contract or in-process class. Finance server as per-trial HTTP sidecar, or stdio in its own venv.

### B2. Settings are accepted but not applied
**Story.** Thu, a config says temperature 0, max steps 20. Hermes sends no temperature. LangGraph raises after about 10 model calls. Hermes makes 20 plus an uncounted summary call.
**Evidence.** Core-loop audit: through a proxy, temperature goes only via `request_overrides`; `max_iterations` refunds and adds a call; truncation is recovered, not stopped. My experience: LangGraph `recursion_limit` counts model and tool nodes; Agents SDK `max_turns` counts model calls and raises.
**L/I** high/high.
**Test (Wed).** Fake LLM, temperature 0.3, 5 steps, every adapter. Assert what arrived. 2 h.
**Mitigation.** Steps mean LLM calls; token budget means total tokens. Enforce both at LiteLLM per trial: virtual key, counter, kill. 3 h.
**Decision.** Config shape: a small common block plus opaque per-adapter `harness_options` holding memory, skills and compression, so the schema is not Hermes-shaped. Unsupported settings: reject or warn.

### B3. "Same tools" stops being true
**Story.** Wed, the tool diff shows Hermes with `mcp__finance__amortize` plus terminal, memory and skill tools, and ADK schemas without `anyOf`. Results arrive as text, dicts or `<untrusted_tool_result>` blocks. Thu, three bad calls pause Hermes's server for 60 s; the trial times out.
**Evidence.** Tools audit: prefix, normaliser, Tool Search, wrapper, breaker counting `isError`. ADK conversion: my experience, unchecked.
**L/I** high/medium; high for harness comparisons.
**Test (Wed, no spend).** Capture each harness's `tools` array and one tool result at the fake LLM. Diff. 2 h.
**Mitigation.** Pre-normalised schemas (audit: they pass unchanged). Restrict Hermes toolsets. Tool-manifest hash per trial. 2 h.
**Decision.** D15. Tool errors as `isError`, which trips the breaker, or as a normal result.

### B4. Provider quirks appear only on real models
**Story.** Thu, Gemini trials on ADK and LangGraph 400 on the second tool turn. The Agents SDK calls `/responses`, which the fake server lacks. Claude rejects temperature with top_p.
**Evidence.** My experience, unchecked: Gemini 3 needs thought signatures echoed back, and frameworks that rebuild messages drop them; the Agents SDK defaults to `OpenAIResponsesModel`. Retries also stack.
**L/I** medium-high/high.
**Test (Wed).** One two-tool task, 5 harnesses, 2 providers, 1 trial: 10 trials, under $1. Needs Rishi's go-ahead.
**Mitigation.** Pin all adapters, Hermes included, to chat completions. Client retries 0; proxy owns retries. 1 h.
**Decision.** Approve the smoke; settle D4 after it.

### B5. The trial view cannot say why a trial failed
**Story.** Fri, ADK shows a stack trace, LangGraph `GraphRecursionError`, Hermes `completed=False, failed=False`.
**Evidence.** Trace research: no harness traces memory. Audit: the summary call fires no hooks; early exits lose tokens.
**L/I** medium/high.
**Test (Wed).** Force step limit, tool error and timeout per harness on the fake LLM. Check stored exit reasons. 2 h.
**Mitigation.** Two harness-neutral views: the LiteLLM log per virtual key, which catches Hermes's hidden call, and the MCP server log. Native traces are enrichment. One `exit_reason` enum, raw reason kept. 3 h.
**Decision.** D12. Proxy as source of truth for tokens and cost.

### B6. The invariance diff is run across harnesses
**Story.** Sat, the UI diffs Hermes and ADK first requests: noise.
**Evidence.** Prompts, tools and wire formats differ by design (B3, B4). Hermes injects date and host facts (audit).
**L/I** medium/medium.
**Test (Wed).** Two identical Hermes configs; diff first requests; expect only date lines.
**Mitigation.** Diff within one harness, normalising date and paths. Across harnesses, compare manifest hashes. 1 h.
**Decision.** Scope of the invariance check.

## 3. The one change I would make today

Write a one-page process contract before any adapter code. In: `trial.json` with task, model alias, proxy URL and key, tool endpoint, common settings, `harness_options`. Out: `result.json` with answer, `exit_reason`, raw reason and advisory usage; optional `events.jsonl`. Each adapter ships a manifest: version, image digest, supported settings, wire format, tool transport. The Claude Agent SDK is then an image with Node, Anthropic format to LiteLLM, native MCP. A GitHub coding agent declares native tools and unmetered calls. Neither touches the core.

One challenge: five harnesses means four images with conflicting pins before Docker runs. Gate each extra harness on the B2 and B3 probes by Wed 18:00, or cut it, recording why. Rishi's call.

## 4. Checked versus assumed

**Checked:** brief; trace research; Hermes tools and core-loop audits; decisions, SPEC; PyPI metadata for google-adk, openai-agents, langchain-mcp-adapters (3 Nov).
**Assumed, unverified:** LangGraph core on 3.14; step semantics outside Hermes; ADK schema handling; Gemini thought signatures; Claude temperature with top_p; Agents SDK defaults; mcp 1.x clients against a 2.x server.
