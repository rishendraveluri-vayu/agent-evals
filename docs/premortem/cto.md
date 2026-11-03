# Pre-mortem: CTO view

## 1. Verdict

Hermes first runs end to end on Thursday, because Docker, the install and the fake server are unproven and five adapters compete for Wednesday. The freeze slips, Friday's pilot-labels-run chain spills into Saturday, and the most-graded parts, the experiment and judge validation, ship thin.

## 2. Breaks, ranked

**B1. Hermes cannot run in a container until Thursday.**
Story: Wednesday, the image still fails to build or `AIAgent` hangs on the fake stream.
Evidence: brief: Docker unusable, install blocked, never imported. Only editable installs work outside Nix (`isolation_and_deployment.md:32`). Without the `[mcp]` extra, MCP does nothing (`custom_tools.md:43`).
Likelihood high. Impact high.
Test, today: `docker run hello-world` as Rishi, then `AIAgent` from an editable `[mcp]` image against a 30-line fake server, `model.streaming: false`.
Mitigation: Rishi does the sudo steps (0.5 h); Claude builds the Dockerfile and fake server (3 h).
Decision: allow the install outside auto mode.

**B2. Thursday carries four SPs and three design gates.**
Story: Thursday 23:00, tasks half-written, rubric untuned, stats untested. The pilot starts Friday 17:00.
Evidence: SPEC puts SP4 to SP7 on Thursday. Tuning labels need a working platform and a go-ahead. On Friday Rishi gates three serial steps. Today's limit and outage cost an hour.
Likelihood high. Impact high.
Test: slice green by Wednesday 22:00.
Mitigation: design tasks and rubric Wednesday morning; build SP6 on simulated data then; small commits, a current handoff note.
Decision: the cut triggers in section 3.

**B3. Five harnesses eat Wednesday (my one challenge to R5).**
Story: an ADK tool-parity bug eats Wednesday night; the cut lands Thursday, hours already spent.
Evidence: the brief asks for one more harness and values design over features. The experiment uses only Hermes. Gemini's guide rewards adding a harness without touching the core; a timed third shows that. SP3 waits on SP1's "every harness". The Parking lot still lists "a third harness".
Likelihood high. Impact medium, because the cut order exists but has no date.
Test: time the own-loop adapter. Over 3 h means five will not fit.
Mitigation: SP1 is done with Hermes plus the own loop. The others come after SP6, 3 h each.
Decision: keep five with a dated trigger, or two plus a timed demo.

**B4. Labelling takes three times the estimate.**
Story: Friday 15:00, 25 of 40 held-out labels done; the run waits.
Evidence: `judge-validation.md` assumes 1.5 minutes a label. My experience: checking a transcript's numbers and its fit to a bereavement takes 3 to 5.
Likelihood high. Impact high.
Test, Wednesday: Rishi times 5 labels.
Mitigation: binary toggles per criterion (2 h), and 5 h blocked for Rishi.
Decision: if a label takes over 3 minutes, cut judge tasks (D7) or label counts.

**B5. Approvals and budget stall the run.**
Story: Friday, Claude waits two hours for a go-ahead; trials then use triple the expected tokens.
Evidence: `cost.md` assumes 8k input tokens per call. Hermes adds tool schemas, skills, memory and environment text. Opus: $122 for 400 trials. A/A doubles the trial count. Rate tiers unchecked.
Likelihood medium. Impact high.
Test, Wednesday: one approved Haiku trial (about $0.01), with tokens recorded.
Mitigation: a standing spending envelope in `experiment.md`, enforced by LiteLLM `max_budget`.
Decision: the envelope, the run model and the A/A model.

**B6. Open decisions stall Claude.**
Story: SP0 waits on D1 to D3; adapters wait on D12, D14, D15.
Evidence: ten open, four due today.
Likelihood medium. Impact high.
Test: tonight, are D1 to D4 settled?
Mitigation: a 30-minute decision session today; D12 and D15 by Wednesday 10:00.

**B7. The first post-freeze bug breaks the freeze.**
Story: the Friday pilot exposes a grader bug. Editing the judge prompt after held-out labels is tuning on them.
Evidence: SPEC freezes the rubric with the platform.
Likelihood medium. Impact medium.
Test, Wednesday: regrade a stored trial without rerunning it.
Mitigation: graders run over stored traces, so a fix is a logged regrade, not a rerun. Pin hashes of tasks, graders, rubric and judge prompt.
Decision: which post-freeze changes are allowed.

**B8. Rishi cannot explain a part.**
Story: asked why the bootstrap resamples tasks first, Rishi knows only the summary.
Evidence: eight SPs and five adapters in four days.
Likelihood medium. Impact high.
Test, Wednesday: Rishi explains the slice aloud, unprompted.
Mitigation: after each SP, Rishi writes his own five-line card (20 min). A part without one is cut or listed as a limit.

## 3. The one change today

Gate everything on a vertical slice green by Wednesday 22:00: one calculation task on Hermes in its own container with one MCP tool, run on the fake server then once on Haiku, graded by exact match, hook-traced, stored in Postgres, shown on a bare Vue page.

Before it: Docker, the image, the fake server, the schema. After it: own loop, tasks, judge, stats, compare view, resume, then other harnesses.

Triggers, for Rishi to approve:
- If the slice is not green, cut both SDKs.
- If there is no freeze tag by Friday 11:00, cut LangGraph and stop the UI at the four video steps.

## 4. Checked versus assumed

Checked: the brief, the SPEC timeline and SP sections, `decisions.md`, `cost.md`, the Hermes audit lines on install, streaming and MCP, and the label plan.

Assumed, nothing run: 3 to 5 minutes per label, over 3 h per adapter, a Hermes prompt above 8k tokens, and that the Docker fix needs sudo and a re-login.
