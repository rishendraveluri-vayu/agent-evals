-- SP4: grading is its own step after the trial (R14), so a grader fix re-grades old trials
-- without re-running them. A grading job is one grading of one trial with a frozen set of grader
-- specs; the grader worker claims it over HTTP (D2), grades the trial's stored files and reports.
-- The grader format is a draft for Rishi (docs/proposals/grader-format.md).

CREATE TABLE grading_jobs (
  id                text PRIMARY KEY,
  trial_id          text NOT NULL REFERENCES trials (id),
  -- trial_done: queued once the trial was done. regrade: POST /experiments/:id/regrade.
  reason            text NOT NULL CHECK (reason IN ('trial_done', 'regrade')),
  -- no_graders: the task has none, so there is nothing to claim. superseded: a newer regrade
  -- replaced it before anyone claimed it. failed: its lease lapsed MAX_CLAIMS times.
  status            text NOT NULL CHECK (status IN ('queued', 'claimed', 'done', 'failed', 'superseded', 'no_graders')),
  task_id           text NOT NULL,
  -- The task.json the graders came from: the current tasks/<id>/task.json when only its graders
  -- changed since the trial ran (catalogue), otherwise the trial's own task (trial_task).
  task_sha256       text NOT NULL,
  grader_source     text NOT NULL CHECK (grader_source IN ('catalogue', 'trial_task')),
  source_note       text,
  -- [{spec, spec_sha256}], in the task's order. spec_sha256 covers the spec and the sha256 of any
  -- file it runs, so the grade's version is computed from exactly what was graded.
  graders           jsonb NOT NULL,
  -- {name: {sha256, base64} | null}: each unit_test's grader file, null when it was not there.
  grader_files      jsonb NOT NULL DEFAULT '{}',
  claims            integer NOT NULL DEFAULT 0,
  worker_id         text,
  claimed_at        timestamptz,
  lease_until       timestamptz,
  reported_at       timestamptz,
  framework_version text,
  -- The task's outcome on this trial: true when every required grader passed, false when one
  -- failed, null (incomplete) when a required grader gave no verdict. SP6 aggregates.
  passed            boolean,
  outcome           text CHECK (outcome IN ('pass', 'fail', 'incomplete')),
  grade_ids         bigint[] NOT NULL DEFAULT '{}',
  problems          jsonb NOT NULL DEFAULT '[]',
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- At most one queued job per trial: a second regrade replaces the queued one (superseded).
CREATE UNIQUE INDEX grading_jobs_one_queued ON grading_jobs (trial_id) WHERE status = 'queued';
CREATE INDEX grading_jobs_claim ON grading_jobs (created_at, id) WHERE status IN ('queued', 'claimed');
CREATE INDEX grading_jobs_trial ON grading_jobs (trial_id, created_at DESC);

-- grades (001) gains what the framework reports. kind stays the data model's coarse family
-- (exact: number and regex; state: tool calls, end state, provenance; unit; judge), with
-- invalid for a spec that names no known type; type is the grader type itself.
ALTER TABLE grades DROP CONSTRAINT IF EXISTS grades_kind_check;
ALTER TABLE grades ADD CONSTRAINT grades_kind_check CHECK (kind IN ('exact', 'unit', 'state', 'judge', 'invalid'));
ALTER TABLE grades ADD COLUMN type text;
ALTER TABLE grades ADD COLUMN required boolean NOT NULL DEFAULT true;
ALTER TABLE grades ADD COLUMN reason text;
ALTER TABLE grades ADD COLUMN spec_sha256 text;
ALTER TABLE grades ADD COLUMN framework_version text;
ALTER TABLE grades ADD COLUMN job_id text REFERENCES grading_jobs (id);
ALTER TABLE grades ADD CONSTRAINT grades_verdict_check
  CHECK (verdict IN ('pass', 'fail', 'not_applicable', 'error', 'not_implemented'));
-- A grade is (trial, grader, version, run). A re-grade that gives the same answer reuses the
-- row; a different answer from the same version (a flaky unit test, a judge re-run) is the next
-- run_index, so nothing is overwritten.
CREATE UNIQUE INDEX grades_identity ON grades (trial_id, grader_id, grader_version, run_index);

-- Each trial's grades as of its latest finished grading job (by queue order), for readers that
-- want one current verdict per grader. grades keeps every version.
CREATE VIEW current_grading AS
  SELECT DISTINCT ON (j.trial_id) j.*
  FROM grading_jobs j
  WHERE j.status = 'done'
  ORDER BY j.trial_id, j.created_at DESC, j.id DESC;

CREATE VIEW current_grades AS
  SELECT g.*
  FROM grades g
  JOIN current_grading j ON j.trial_id = g.trial_id AND g.id = ANY (j.grade_ids);
