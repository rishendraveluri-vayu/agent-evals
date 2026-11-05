-- D72: a regrade also covers the trials arm A reuses from a parent experiment (D34), which belong
-- to the parent. A grading job queued by POST /experiments/:id/regrade records that experiment, and
-- its claim hands out that experiment's judge approval, so a reused trial is judged under the
-- regrading experiment's approval and budget, never the parent's. Null for a first grading
-- (`trial_done`), which uses the trial's own experiment's approval as before.
-- No foreign key: an exported example's grading jobs may name an experiment not shipped with it
-- (a child that regraded the example's trials before it was exported).
ALTER TABLE grading_jobs ADD COLUMN regrade_experiment_id text;
