-- SP5, D73: more than one human rater. Every label carries its rater's id, and each rater has
-- their own queue and second looks. Labels written before D73 are Rishi's: the rows already here
-- become `rishi`, as the lines of labels/<set>.jsonl without a "rater" field do on import.
-- The default only fills those rows and is then dropped, so no new label is ever Rishi's by default.
ALTER TABLE labels ADD COLUMN rater text NOT NULL DEFAULT 'rishi';
ALTER TABLE labels ALTER COLUMN rater DROP DEFAULT;
ALTER TABLE labels ADD CONSTRAINT labels_rater_id CHECK (rater ~ '^[a-z0-9_-]{1,40}$');
CREATE INDEX labels_set_trial_rater ON labels (label_set, trial_id, rater);
