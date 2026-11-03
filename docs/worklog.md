# Worklog

Not required by the brief. It records what was built and by whom, so the next-round conversation is easy. Keep it or remove it before submission.

## Tue 3 Nov

- Rishi: scope, budget, deadline, LiteLLM.
- Claude: read the brief and Hermes source, measured Hermes prompt overhead, drafted this spec and the doc stubs.
- Rishi ruled: four harnesses (R1), modular adapters (R2), explicit self-improvement only (R3), trace standard research (R4). Opened D11 and D12.
- Rishi settled D11 as both SDKs (R5, five harnesses) and D13 as a personal-finance assistant (R6). Opened D14 on tool delivery.
- Claude: launched research on agent-eval methodology, Hermes architecture and traces, and trace standards. Reports land in `docs/research/`.
- Claude delivered: `docs/research/reports/Agent evals state of the art.md` and `docs/research/reports/Hermes architecture and traces.md`, from five eval notes, one trace-standards brief and four Hermes code audits. Hermes notes rewritten with the audit corrections. D15 opened.
- Claude ran a pre-mortem with five reviewers (CTO, eval methodology, platform, integration, hiring panel) on a shared brief that included Gemini's analysis. Summary in `docs/premortem/summary.md`. Verified that the harnesses' pinned dependencies conflict.
- Surprises: Hermes self-modifies by default once memory or skills are on; `skip_memory` does not turn memory off; most of the trace lives in plugin hooks, not callbacks; MCP works unmodified but wraps results as untrusted. Two interruptions, a usage limit and a network outage, cost about an hour; no work was lost.

## Entry template

```markdown
## <day>
- Rishi designed: ...
- Claude implemented: ...
- Surprises: ...
```
