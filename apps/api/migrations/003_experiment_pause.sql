-- D26: an infra:config_error report pauses its experiment. While paused, no trial is claimed;
-- trials already running finish and report. POST /experiments/:id/start resumes it.
-- `paused_reason` says why (the trial, its config and the provider's error), for the events list.
ALTER TABLE experiments DROP CONSTRAINT experiments_status_check;
ALTER TABLE experiments ADD CONSTRAINT experiments_status_check
  CHECK (status IN ('created', 'running', 'paused', 'done', 'cancelled'));
ALTER TABLE experiments
  ADD COLUMN paused_at timestamptz,
  ADD COLUMN paused_reason text,
  ADD COLUMN resumed_at timestamptz;
