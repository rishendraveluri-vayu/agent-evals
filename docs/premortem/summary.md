# Pre-mortem summary

Tue 3 Nov 2026. Five reviewers, one shared brief (`brief.md`), prompt in `prompt.md`. Full reviews: `cto.md`, `methodology.md`, `platform.md`, `integration.md`, `panel.md`.
Inputs: our research, the Hermes code audits and Gemini's independent analysis. Nothing was run except one dependency check, noted below.

## The verdict, merged

Every reviewer told the same story from a different seat. The real path first runs end to end on Thursday, not Tuesday, because Docker, the Hermes install, the fake LLM server and five adapters all compete for Wednesday. Its plumbing bugs then eat the crunch, the freeze slips, and Friday's chain of pilot, labels, run and labels spills into Saturday. What ships thin is exactly what the brief grades hardest: the experiment, the judge validation and the statistics. And the memory experiment's headline would be true by construction.

## The breaks, ranked

"Seats" counts how many of the five reviewers raised it independently.

| # | Break | Seats | Likelihood / impact |
| --- | --- | --- | --- |
| 1 | The real path first runs Thursday | 5 | High / high |
| 2 | Memory experiment true by construction; other tiers at ceiling | 3 | High / high |
| 3 | Five harnesses crowd out depth | 3, challenging R5 | High / high |
| 4 | Harnesses cannot share a Python environment | 2, **verified** | High / high |
| 5 | Settings accepted but not applied the same way | 2 | High / high |
| 6 | Statistics cannot reach significance at tier level; budget does not fit a full A/A | 3 | High / high |
| 7 | Judge and rater share a bias toward the seeded arm; labelling takes 2 to 3 times the estimate | 3 | High / high |
| 8 | Concurrent trials share one ledger | 2, plus Gemini | High / high |
| 9 | Kill-and-resume double-runs trials | 1 | High / high |
| 10 | Tokens, cost and failures don't reconcile | 4, plus Gemini | Medium / high |
| 11 | Tools are not the same across harnesses | 2 | High / medium |
| 12 | Fake LLM server simpler than reality | 2 | High / medium |
| 13 | Clean-clone compose plumbing breaks | 1 | High / high |
| 14 | No git repo, so pre-registration cannot be proven | 2 | Medium / high |

**1. The real path first runs Thursday.** Docker does not work for your user, the compose plugin is missing, Hermes has never been imported, and a previous attempt found Claude Code's auto mode blocked installing it. After you join the `docker` group, Claude Code must be restarted to see it. SP0 also waits on D1 to D3. All five reviewers converged on the same fix: one walking skeleton before anything else. That is one task on Hermes in its own container, on a streaming fake LLM behind real LiteLLM, graded, traced, stored, shown, and surviving a kill test. Targets proposed ranged from Wednesday noon to Wednesday 22:00.

**2. The memory experiment is true by construction.** Hermes reads memory only as a frozen system-prompt snapshot, so "seeded versus empty" means "client facts in the prompt or not". Tier 1 can pass only when seeded and carries the whole headline on its own. Tiers 2 and 3 sit near ceiling because the tools do the maths, so their honest verdict is "undetermined". Two further traps: seeded entries matching Hermes's threat patterns are silently replaced with `[BLOCKED]`, and seeds written by the task author may contain the graded number. The proposed fix:
- **Tier 1 is a manipulation check**, outside the headline.
- **Tier 2 is the real hypothesis**, measured on steps, tokens and cost, which are continuous.
- **Tier 3 is a non-inferiority test** with a declared margin and a criterion against raising irrelevant circumstances.
- All of it is pre-registered before the tier tasks are written on Wednesday.

**3. Five harnesses crowd out depth.** The CTO, the integration engineer and the panel each used their one challenge on R5. The experiment uses only Hermes. The brief and Gemini's guide both rank design over feature count. The panel's interview question: "What did four more adapters buy?" Their three proposals, for you to choose between, are in the decisions section below.

**4. The harnesses cannot share a Python environment. Verified today.** I ran a resolve-only check with `uv pip compile`; nothing was installed.
- Hermes pins `mcp==2.3.0`; `langchain-mcp-adapters` 0.3.2 needs `mcp<2`. No solution.
- `openai-agents` 0.24.0 needs `openai>=3`; `google-adk[extensions]` 2.13.0 needs `openai<3`. No solution.
- Python 3.14 is not the blocker. The conflicts force one image per harness, and an adapter that is a process contract rather than a Python class inside one worker.

**5. Settings accepted but not applied.** Hermes sends no temperature through a proxy unless the adapter passes it. "Max steps 20" counts different things in each framework, and Hermes adds an uncounted summary call at the cap. The fix is to enforce steps and tokens at LiteLLM per trial key, and to check on the wire with the fake LLM that every setting arrived.

**6. The statistics cannot reach significance at tier level.** An exact sign-flip test on k task deltas has a smallest possible two-sided p of 2/2^k: 0.0625 at five tasks, whatever N is. With about 20 tasks, effects under roughly 6 to 25 points are undetectable. A full A/A on Claude roughly doubles spend past the $100 budget. Proposed fixes: one pre-registered task-level test, per-task deltas reported descriptively, a minimum-detectable-effect curve beside the verdict, and an A/A run on a cheap model or as split halves. Methodology disagrees with Gemini on one point: judge non-determinism widens variance but does not invalidate a task-level paired test.

**7. Judge and rater share a bias.** Seeded replies mention the client's circumstances, so neither the judge nor you can be blind to the arm. Judges are weakest on emotional framing and lean lenient. You wrote the tasks and hold the hypothesis, so high kappa may just mean you and the judge share a bias. The fix is criteria written as observable substance checks before seeing outputs, with agreement reported per arm. Labelling is likely 3 to 5 minutes per label, not 1.5. Time five labels on Wednesday.

**8. Concurrent trials share one ledger.** If one MCP server owns the ledger outside the trial containers, trial B's state check sees trial A's writes and gets plausible, wrong grades. The fix is a ledger per trial, owned by the trial container. Tasks phrased "as of today" also change their exact answers daily; fix the as-of date.

**9. Kill-and-resume double-runs trials.** Trial containers launched through the Docker socket are siblings of the worker, not its children, so they survive a killed worker. The lease expires, the trial is claimed again, and both attempts spend money and report. The fix is to label and reap containers, heartbeat leases, reject reports from stale attempts and revoke the trial's key on expiry: about 3 to 4 hours.

**10. Tokens, cost and failures don't reconcile.** Hermes drops tokens on early exits and on the step-cap summary call. LiteLLM prices unknown models at zero and may lag recording spend under parallel trials. The seeded arm's longer prompts draw more rate limits, so retries, latency and timeouts track the arm. The fix is cost from the per-trial LiteLLM key, refusing unpriced models, budget stop as its own outcome, interleaving arms, and reporting retries beside latency.

**11. Tools are not the same across harnesses.** Hermes prefixes names, adds its own tools, wraps results as untrusted and trips a breaker after three errors. Other frameworks may rewrite schemas. The fix is to capture and diff each harness's `tools` array at the fake LLM, and to hash the tool manifest per trial.

**12. The fake LLM server is simpler than reality.** Hermes streams by default with usage only on request. The OpenAI Agents SDK likely defaults to the Responses API. Hermes adds cache markers only for a host named like `litellm`. The fake server must stream with chunked tool-call arguments, sit behind real LiteLLM in tests, and every adapter should be pinned to chat completions.

**13. Clean-clone compose plumbing breaks.** Bind-mount paths resolve on the host, not in the worker. Trial images are not built by `compose up`. The network name changes with the folder name. A cold build is an estimated 15 to 30 minutes. The fix is a fixed compose project name and network, build-only services per harness image, Hermes vendored at the pin rather than cloned at build time, results over stdout or HTTP, and missing output counted as infra failure.

**14. No git repo.** The experiment plan must be committed before the run so the history proves it came first. Run `git init` today.

## Tests to run by Wednesday

None of these spend money unless marked.

1. **Docker.** In a fresh terminal: `docker compose version` and `docker run --rm hello-world`.
2. **Dependency pairs.** Done today: two conflicts confirmed.
3. **Walking skeleton.** Hermes container, streaming fake behind real LiteLLM, then kill the worker mid-run and assert one result per trial and no stray containers.
4. **Settings on the wire.** Temperature 0.3 and 5 steps through every adapter; assert what arrived at the fake LLM.
5. **Tool manifest diff.** Capture each harness's tools array and one tool result; diff them.
6. **Seeded prompt render.** Every seeded fact present, none `[BLOCKED]`, no graded number in any seed.
7. **Ledger canary.** Two concurrent ledger tasks; one writes markers; the other must find none.
8. **Statistics on simulated data.** SP6 at 4, 8 and 12 tasks with known effects.
9. **Label timing.** You label five smoke traces against a clock.
10. **Cheap real smoke, needs your go-ahead.** One two-tool task, each harness, two providers, one trial: about 10 trials, under $1.

## Decisions this forces

**Today:**
- **R5, five harnesses.** Three options from the reviewers:
  - **Keep five with dated cut triggers.** No green skeleton by Wednesday 22:00 cuts both SDKs. No freeze tag by Friday 11:00 cuts LangGraph and stops the UI at the four video steps.
  - **Hermes and own loop first.** Build those two to SP1's done-when, go straight to SP3 to SP6, and add the others only after SP6 passes. A README walkthrough shows how a new harness is added.
  - **Gate each extra harness on probes.** Each must pass the settings and tool probes by Wednesday 18:00, or be cut with the reason recorded.
- **D1, D2, D3.** SP0 cannot start without them.
- **D9 and the tier design.** The tier tasks are written Wednesday, so the analysis plan must exist first. If memory fails as an axis, methodology's fallback is Hermes versus the own loop on one model.
- **Environment.** You run the Docker sudo steps, then restart Claude Code. Allow the Hermes install outside auto mode. Run `git init`.
- **Spending envelope.** A standing budget for smoke and pilot runs, enforced by LiteLLM, so runs don't wait on approvals.

**By Wednesday morning:**
- **Adapter contract.** A process contract with `trial.json` in and `result.json` with an `exit_reason` out, plus a capability manifest per adapter. The alternative is an in-process Python class, which the dependency conflicts now rule out for a shared environment.
- **Config shape.** A small common block plus opaque per-harness options holding memory, skills and compression, so the schema is not Hermes-shaped. Unsupported settings are rejected or warned.
- **D14 variant.** Ledger per trial, MCP over stdio inside the container or HTTP keyed by trial, and whether tool errors are reported as MCP errors that trip Hermes's breaker.
- **D12, D15, D7, D8, D10.** As already listed in `docs/decisions.md`.
- **Infra versus agent.** How a timeout after heavy rate-limit backoff is labelled, and whether retried trials count in latency.
