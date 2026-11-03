# Platform pre-mortem

## 1. Verdict

The real path (compose worker, sibling trial containers, LiteLLM, Postgres lease) first runs end to end at Thursday's pilot, and its plumbing bugs eat the crunch. The worst corrupt results quietly: orphaned or state-sharing trials that look valid.

## 2. Breaks (likelihood / impact)

### B1. Docker does not work here until Wednesday (high / high)
- **Story.** Tue evening compose cannot start. Rishi joins `docker`, but Claude Code's shell keeps its old groups until restarted. SP0 slips a day, SP3 with it.
- **Evidence.** Brief: no group, no plugin, installs blocked before. SP0 needs D2 and D3, still open.
- **Test.** Today, fresh terminal: `docker compose version`, `docker run --rm hello-world`.
- **Fix.** Rishi by hand, then restart Claude Code; 0.5 h. Read `DOCKER_HOST`; never hard-code the socket.
- **Decision.** D2, D3 today. Docker group (root-equivalent) or rootless.

### B2. Kill-and-resume double-runs trials (high / high)
- **Story.** Wed, SP3 test: `docker kill worker`. Trial containers keep running: siblings, not children. The lease expires, a new worker re-claims, two attempts spend. The orphan reports late, a duplicate. Fixed leases also expire on long healthy trials.
- **Evidence.** My socket-launched-job experience; audit §9: leftovers die only with the container.
- **Test.** Fake sleeps 20 s per call; six trials; kill at 10 s; restart. Assert one result each, no stray containers, call count equals recorded attempts.
- **Fix.** Label containers by trial and attempt, reap on start. Heartbeat leases. Reject stale attempt tokens. Revoke the trial key on expiry. 3 to 4 h.
- **Decision.** On resume, recover finished output or re-run? Does a dead attempt's spend count?

### B3. Compose plumbing breaks on a clean clone (high / high)
- **Story.** Wed: the worker mounts `/app/runs/t42`; the host daemon creates it empty and root-owned, and "no output" scores as agent failure. Sat clean clone: the first trial fails "image not found"; trial images are not services. A different folder renames the network; `litellm` stops resolving. Cold build: 15 to 30 min, 5 to 8 GB (my estimate). Build-time `git clone` of Hermes is outage-prone.
- **Evidence.** Docker-out-of-Docker behaviour (my experience); audit §1: size unmeasured, `uv sync --frozen` unrun.
- **Test.** Wed: prune images, clone elsewhere, time `up` to a fake trial whose output the worker reads.
- **Fix.** Fixed compose `name:` and network. Build-only services, one image per harness, so 3.14 binds only Hermes. Vendor Hermes at the SHA. Results over stdout or HTTP. Missing output is infra. 3 to 4 h.
- **Decision.** Per-harness or shared base image; how results leave the container.

### B4. Concurrent trials share the ledger (high if MCP is one service / high)
- **Story.** Thu pilot, four at once, one MCP service, one ledger. Trial B's state check sees trial A's writes. Plausible, wrong grades.
- **Evidence.** Gemini's first item; state-of-the-art report: outside tools escape container isolation.
- **Test.** Two concurrent ledger tasks on the fake; diff end states.
- **Fix.** Ledger per trial, owned by the trial container. 1 to 2 h.
- **Decision.** D14: stdio inside each trial, or shared HTTP keyed by trial.

### B5. LiteLLM budgets, prices, retries (medium / high)
- **Story.** Fri: spend writes lag, so parallel trials overshoot `max_budget`. A $0-priced OpenRouter model never trips it. At the cap, the rest fail fast as agent failures. 429s retry in the SDK, LiteLLM and maybe Hermes; backoff eats the timeout and the throttled arm "fails". The seeded arm's longer prompts draw more 429s.
- **Evidence.** Brief; state-of-the-art report (zero pricing, retry billing, HAL latency inflation). Spend lag: assumed.
- **Test.** Fake behind real LiteLLM: set price, $0.05 key budget, scripted 429s.
- **Fix.** Refuse unpriced models. Budget stop is its own outcome and halts the queue. Cost and tokens from LiteLLM per trial key, not harness totals (Hermes drops the step-cap call). Record retries and backoff. Interleave arms. Assert response cache off at start. 3 h.
- **Decision.** Timeout after heavy backoff: infra or agent? Retried trials in latency stats?

### B6. The fake is simpler than reality (high / medium)
- **Story.** Thu pilot: Hermes streams, usage comes only on request, tokens are null. The Agents SDK defaults to the Responses API, which the fake never spoke. Hermes adds cache markers only for a `litellm` host; tests against `fake-llm` took another path.
- **Evidence.** Brief. Agents SDK default: my experience.
- **Test.** Fake upstream of real LiteLLM, streaming on, one task per harness.
- **Fix.** SSE with chunked tool-call arguments, optional usage chunk, scripted errors. 4 to 6 h.
- **Decision.** Pin the Agents SDK to chat completions, or support Responses.

## 3. The one change today

A walking skeleton before any second adapter: compose up, one Hermes container against the streaming fake behind real LiteLLM, report over HTTP, pass B2's kill test. Target Wednesday noon. Then, with Rishi's go-ahead, one cheap real trial per harness, Wednesday not Thursday.

## 4. Checked versus assumed

Checked: brief; SPEC SP0 to SP3; decisions.md; audit §1, §9; state-of-the-art infra, container, cost sections.

Assumed, not run: 3 to 10 s startup per trial (container, Hermes import, MCP, key), recorded apart from agent latency; image sizes; build times; spend lag; the Agents SDK default.

Pushback: GitHub-hosted runners have Docker, so CI can run the compose smoke and kill tests. Rate limits, real streaming, pricing and judge behaviour wait for the first real run.
