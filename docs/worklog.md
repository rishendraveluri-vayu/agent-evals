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
- Rishi ruled R7: five harnesses stay, built in parallel once Hermes and the own loop run one task end to end, each gated on the settings and tool tests. Deadline per harness still to set.
- Environment fixed with Rishi's sudo: Docker group, compose and buildx, `gh` login. Claude: Hermes installed at the pin on Python 3.14 and imports cleanly; pnpm 10.34.9; git repo initialised and the first commits made.
- Surprises: pnpm 12 does not run under Node 22.14's corepack; a bare `import run_agent` builds a whole Hermes home folder, so `HERMES_HOME` must be set per process before import.
- Rishi settled D4 (Gemini is the second provider), set R7's deadline (Thursday 12:00 per extra harness), ruled R8 (every real run is scoped and signed off, even under a dollar; no standing budget) and R9 (fake model server for tests and CI, plus real dev runs on Haiku 5.5 and Gemini Flash).
- Claude started `docs/design.md`: decided entries and verified constraints only, open items pointing at `decisions.md`.
- Rishi settled D1 (graders and stats in Python) and D2 (HTTP through the API; workers never touch the database), and delegated D3 to "simpler and more robust". Claude chose one long-lived container per harness with a fresh process per trial, and logged the tradeoff.

## Entry template

```markdown
## <day>
- Rishi designed: ...
- Claude implemented: ...
- Surprises: ...
```
