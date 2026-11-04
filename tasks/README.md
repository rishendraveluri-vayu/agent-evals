# Task set (SP4, [Rishi designs]). One folder per task: tasks/<id>/task.json, see docs/api-contract.md.

Engine tests: folders named `engine-*` are synthetic tasks for the run engine (scripts/sp3_kill_test.py) with fake models. They are not part of the task set.

For a conversation task, the simulated client's hidden facts must agree with the task's client file, which the agent reads through its tools; a hidden fact that contradicts the file makes the client argue with its own records (seen 4 Nov). The API shows the simulator the profile, the debts and the latest month's transactions (D30).

Required tools: list them once in `task.json` as `"required_tools": ["calculate_emi"]` when the rule is only "these tools must have been called"; the runner records it in every trial's `checks.json`, and a `{"type": "required_tools"}` grader makes it count towards the pass. Use a `tool_called` grader instead when the arguments or the number of calls matter. `docs/proposals/grader-format.md` has both.

Draft tasks (`draft-*`, all DRAFT for Rishi) are written by `scripts/make_draft_tasks.py`, which computes every expected number with the finance server's calculators: run it from `services/finance-mcp` (`uv run python ../../scripts/make_draft_tasks.py`); it rewrites every draft's `task.json` and client file. A `unit_test` grader's file (`grader.py`) sits next to `task.json` and is hand-written, not generated; `graders/tests/test_task_graders.py` tests each one on hand-made trials. Most client-file tasks use Meera's file (the finance server's example client); `draft-convo-phone-loan` has its own synthetic client, Rohan. The review of the whole set, with proposed severities and splits, is `docs/proposals/tasks-review.md`.
