-- D33, D38: the pre-run rendered prompt and conflict check, and the platform's own spend.
--
-- A probe trial runs one config once on the fake model (fake/finance-emi) through the normal
-- claim and report protocol, outside any experiment, so the API can read the exact system
-- prompt the harness sent from the stored first request. It belongs to no experiment and is
-- never counted in experiment results, estimates, labels or trial spend.
ALTER TABLE trials ALTER COLUMN experiment_id DROP NOT NULL;
ALTER TABLE trials ADD COLUMN probe boolean NOT NULL DEFAULT false;
ALTER TABLE trials ADD CONSTRAINT trials_probe_has_no_experiment
  CHECK ((probe AND experiment_id IS NULL) OR (NOT probe AND experiment_id IS NOT NULL));
CREATE INDEX trials_probe_config ON trials (config_hash, created_at DESC) WHERE probe;
-- At most one live probe per config, so two clicks never queue two.
CREATE UNIQUE INDEX trials_one_live_probe ON trials (config_hash)
  WHERE probe AND status IN ('queued', 'claimed', 'running');

-- One rendered prompt per config, from its first finished probe: the system text with the date
-- and model normalised (as evals_adapter.invariance.normalise does), the tool names, and where
-- our task prompt sits in it. A config hash covers the harness ref, adapter, prompt and
-- settings, so the same config always renders the same prompt.
CREATE TABLE rendered_prompts (
  config_hash   text PRIMARY KEY REFERENCES configs (hash),
  trial_id      text NOT NULL REFERENCES trials (id),
  sha256        text NOT NULL,
  system_text   text NOT NULL,
  tools         jsonb NOT NULL,
  ours_start    integer,
  ours_end      integer,
  harness_text  text NOT NULL,
  normalised    jsonb NOT NULL,
  caveats       jsonb NOT NULL DEFAULT '[]',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Model calls the platform makes itself (D38), outside any trial: each is one row, with its
-- cost from LiteLLM's spend log. A row is written `pending` with a worst-case reservation before
-- the call and settled after it, so a crash mid-call still counts against the allowance.
CREATE TABLE system_spend (
  id                 text PRIMARY KEY,
  kind               text NOT NULL,
  model              text NOT NULL,
  status             text NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
  reserved_usd       double precision NOT NULL,
  cost_usd           double precision,
  cost_source        text,
  input_tokens       integer,
  output_tokens      integer,
  ref                text NOT NULL,
  litellm_request_id text,
  error              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  settled_at         timestamptz
);
CREATE INDEX system_spend_kind ON system_spend (kind, created_at);

-- Conflict-check results, cached by what the checker was given: the rendered prompt, our task
-- prompt and the config's settings (input_sha256), the checker prompt and the model, so the
-- same input never pays twice.
CREATE TABLE conflict_checks (
  id              text PRIMARY KEY,
  input_sha256    text NOT NULL,
  rendered_sha256 text NOT NULL,
  checker_sha256  text NOT NULL REFERENCES prompts (sha256),
  checker_version text NOT NULL,
  model           text NOT NULL,
  config_hash     text NOT NULL REFERENCES configs (hash),
  conflicts       jsonb NOT NULL,
  notes           text NOT NULL,
  raw_reply       text NOT NULL,
  spend_id        text REFERENCES system_spend (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (input_sha256, checker_sha256, model)
);
