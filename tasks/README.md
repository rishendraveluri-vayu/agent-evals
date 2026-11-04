# Task set (SP4, [Rishi designs]). One folder per task: tasks/<id>/task.json, see docs/api-contract.md.

Engine tests: folders named `engine-*` are synthetic tasks for the run engine (scripts/sp3_kill_test.py) with fake models. They are not part of the task set.

For a conversation task, the simulated client's hidden facts must agree with the task's client file, which the agent reads through its tools; a hidden fact that contradicts the file makes the client argue with its own records (seen 4 Nov). The API shows the simulator the profile, the debts and the latest month's transactions (D30).
