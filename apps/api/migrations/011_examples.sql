-- SP7: shipped examples. A finished experiment exported to examples/<name>/ (scripts/export_example.py)
-- is loaded on request by POST /examples/:name/load, which only inserts. The loaded experiment is
-- marked here and stays read-only: nothing claims, grades, judges or runs it (docs/api-contract.md,
-- Examples), and its trials are left out of spend, estimates and the label queue.
ALTER TABLE experiments
  ADD COLUMN example_name text,
  ADD COLUMN example_title text,
  ADD COLUMN example_loaded_at timestamptz;
-- An example is a finished run: it can never be started, so no trial of it is ever queued.
ALTER TABLE experiments ADD CONSTRAINT experiments_example_finished
  CHECK (example_name IS NULL OR status IN ('done', 'cancelled'));
CREATE INDEX experiments_example ON experiments (example_name) WHERE example_name IS NOT NULL;
