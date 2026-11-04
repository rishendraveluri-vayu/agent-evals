# Proposal: the data model (SP2) — for Rishi's approval

Status: **proposal, 4 Nov 2026**. SP2 is **[Rishi designs]**. Nothing here is built until
Rishi approves it or changes it. It follows decisions already made: D2 (workers only claim and
report over HTTP), D3 (one trial folder per trial), R10.9 (LiteLLM is the source of truth for
calls and cost), R11a (runs, results, spans and logs are stored and indexed, the folder is
transport only), and the SP2 done-when: a past result traces back to the exact config, task
and code versions.

## The idea in one paragraph

Everything that defines a trial is **content-addressed**: a task, a prompt, a toolset and a
config each have a hash of their content, so the same content always gets the same id and
any change gets a new one. An **experiment** is a frozen list of task hashes × config hashes
× N, plus the platform commit. Each **trial** row is one (experiment, task, config, repeat)
slot with a status machine; workers claim and report trials through the API. Results,
spans, grades and labels hang off the trial. Raw files stay on disk under `runs/`, and the
database keeps their paths and hashes.

## Tables

| Table | Key | Holds | Why |
| --- | --- | --- | --- |
| `prompts` | `sha256` | id, version, text | Prompts are first-class and versioned (R11c). |
| `toolsets` | `sha256` | id, version, MCP servers, allowed tools | The tools axis (R11c). |
| `tasks` | `sha256` of the task file | task id, version, split (discovery / held-out), messages, client_sim, grader specs, source path | A task file edit makes a new version; old results keep pointing at the old one. |
| `configs` | `hash` | name, harness, harness ref (pinned SHA or package version), adapter version, model name and pin, prompt sha, toolset sha, settings, harness options | Content hash over everything that can change behaviour, so a result reproduces (SP2). |
| `experiments` | `id` | name, axis, config hashes (A, B), task hashes, N, platform commit, plan commit (`experiment.md`), estimate, budget cap, status, timestamps | The frozen plan. Changing anything makes a new experiment. |
| `trials` | `id`; unique (experiment, task, config, repeat, attempt) | status, worker id, claimed / heartbeat / finished times, label, end state, runner report, result (JSONB), LiteLLM usage (calls, tokens, cost, complete), wall time, trial folder path | The unit of work. The unique key makes claiming and re-queueing idempotent. |
| `spans` | (trial, span id) | parent, name, kind, start, end, attributes (JSONB) | Indexed for the trace view and failure analysis (R11a). |
| `grades` | `id` | trial, grader id and version, kind (exact / unit / state / judge), verdict, score, evidence (quotes), judge model, run index | Several graders per trial; the run index holds judge test-retest. |
| `labels` | `id` | trial, criterion, value, set (tuning / held-out / final), labelled at | **Imported read-only from `labels/` files**, which stay the source (never written or inferred by code). |

## Trial status machine

`queued → claimed → running → done` or `→ infra_failed → queued` (re-queued once, D16) or
`→ abandoned` (a lapsed claim past the cap). Only the API changes status.
- **Claim:** `UPDATE trials SET status = 'claimed', worker = $1 WHERE id = (SELECT id FROM trials
  WHERE experiment = $2 AND status = 'queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)`.
- **Heartbeat** every 10 s while running. A claim with no heartbeat for 60 s lapses, so a crash
  never leaves a trial stuck (SP3 done-when).
- **Report** is idempotent: reporting the same attempt twice is a no-op, so a retried HTTP call
  cannot duplicate a result.
- Infra failures are labelled, kept, and counted in every report (CLAUDE.md: never dropped).

## What stays a file

- `runs/<experiment>/<trial>/`: spec, result, trace, runner report, logs, stored request and
  response bodies. The database stores the path and a hash of each file.
- `labels/*.jsonl` and `tasks/`, `configs/` in git.
- Export (SP2) is JSON and CSV per experiment into `experiments/<id>/`: trials joined with
  grades, configs and tasks, plus spend.

## Choices for you

1. **Config identity.** The hash covers harness ref, adapter version, model pin, prompt sha,
   toolset sha, settings and harness options. Recommended: also include the adapter's
   `capabilities.json` hash, so a re-probed adapter counts as a new config.
2. **Where results live.** Recommended: result and runner report as JSONB on the trial row,
   spans in their own table, everything else as files. The alternative (all in the database)
   makes the database large for little gain.
3. **Labels.** Recommended: files in `labels/` stay the source of truth and the database
   imports them read-only; the labelling view writes the file through the API.
4. **Grades.** Recommended: grading runs after the trial, as its own step, so a grader fix
   re-grades old trials without re-running them.

## Changes since approval

Each is a migration under `apps/api/migrations/`; `docs/design.md` section 3 says what each is for.

- `002_sim_replies.sql` (D22): the simulator reply cache.
- `003_experiment_pause.sql` (D26): the `paused` experiment status.
- `004_sim_temperature_optional.sql` (D27): a simulator may send no temperature.
- `005_run_controls.sql` (D32, D34, D35, D37, review item 8): lineage (`configs.parent_hash`,
  `experiments.parent_experiment_id`, `reuse_baseline`, `baseline_decision`); an
  `experiment_arms` table for per-arm pauses and reused trials; `trials.order_index` with
  `experiments.order_seed` for the seeded claim order; `experiments.futility` and
  `spend_guard_at`; an `experiment_events` table for pauses, resumes, stops and the baseline
  decision; and a `workers` table of when each worker was last seen. The trial status machine is
  unchanged: a paused arm's trials stay `queued`, and a stop cancels the queued ones.
- `008_config_seed.sql` (D39): `configs.seed`, seeded memory and skills, in the hash when not
  empty.
