-- SP4: the LLM judge's approval, one experiment at a time (R8: no real-model spend without
-- Rishi's sign-off with a cap). An approval names the judge model and a budget; the API mints one
-- LiteLLM key for it, limited to that model and capped at that budget, and hands the key to the
-- grader worker in each grading claim for that experiment's trials. Revoking deletes the key in
-- LiteLLM. The key is kept here because every claim hands it out again; no UI-facing route
-- returns it. `key_token` is LiteLLM's hash of it, to read its spend log and to delete it.
CREATE TABLE judge_approvals (
  id             text PRIMARY KEY,
  experiment_id  text NOT NULL REFERENCES experiments (id),
  model          text NOT NULL,
  budget_usd     numeric NOT NULL CHECK (budget_usd > 0 AND budget_usd <= 20),
  key            text NOT NULL,
  key_token      text NOT NULL,
  approved_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  -- What LiteLLM's spend log said the key had spent when it was revoked: the floor, and the
  -- figure shown if LiteLLM cannot be read later. Null while active, or if it could not be read.
  revoked_spend_usd double precision
);
-- At most one active approval per experiment.
CREATE UNIQUE INDEX judge_approvals_one_active ON judge_approvals (experiment_id) WHERE revoked_at IS NULL;
CREATE INDEX judge_approvals_experiment ON judge_approvals (experiment_id, approved_at);
