-- SP2 data model, as approved by Rishi on 4 Nov (R14, docs/proposals/data-model.md).
-- Prompts, toolsets, tasks and configs are content-addressed: the key is a hash of the
-- content, so the same content always has the same key and any change gets a new one.
-- Hashes are stored as 'sha256:<hex>'.

CREATE TABLE prompts (
  sha256        text PRIMARY KEY,
  id            text NOT NULL,
  version       text NOT NULL,
  text          text NOT NULL,
  path          text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prompts_id_version ON prompts (id, version);

CREATE TABLE toolsets (
  sha256        text PRIMARY KEY,
  id            text NOT NULL,
  version       text NOT NULL,
  servers       jsonb NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now()
);

-- sha256 is of the task.json bytes. client_state is the file it names, kept here so a past
-- trial can be re-run with exactly the state it had.
CREATE TABLE tasks (
  sha256              text PRIMARY KEY,
  id                  text NOT NULL,
  version             text NOT NULL,
  split               text NOT NULL CHECK (split IN ('discovery', 'held_out')),
  kind                text NOT NULL,
  summary             text NOT NULL,
  body                jsonb NOT NULL,
  client_state_name   text,
  client_state        bytea,
  client_state_sha256 text,
  source_path         text NOT NULL,
  first_seen_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_id ON tasks (id);

-- hash covers harness ref, adapter version, capabilities sha256, model, prompt sha256,
-- toolset sha256, resolved settings and harness options. The capabilities file is kept, so
-- the spec for a trial is built from what the config was validated against.
CREATE TABLE configs (
  hash                text PRIMARY KEY,
  name                text NOT NULL,
  harness             text NOT NULL,
  harness_package     text NOT NULL,
  harness_ref         text NOT NULL,
  adapter_version     text NOT NULL,
  capabilities_sha256 text NOT NULL,
  capabilities        jsonb NOT NULL,
  model               text NOT NULL,
  api_format          text NOT NULL,
  prompt_sha256       text NOT NULL REFERENCES prompts (sha256),
  toolset_sha256      text NOT NULL REFERENCES toolsets (sha256),
  settings            jsonb NOT NULL,
  settings_sources    jsonb NOT NULL,
  harness_options     jsonb NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX configs_harness ON configs (harness);

-- The frozen plan. Changing anything makes a new experiment.
CREATE TABLE experiments (
  id                text PRIMARY KEY,
  name              text NOT NULL,
  axis              text NOT NULL,
  config_hashes     text[] NOT NULL,
  task_sha256s      text[] NOT NULL,
  n                 integer NOT NULL CHECK (n >= 1),
  sim_model         text,
  sim_prompt_sha256 text REFERENCES prompts (sha256),
  sim_temperature   double precision,
  sim_max_output_tokens integer,
  budget_usd        double precision NOT NULL CHECK (budget_usd > 0),
  trial_budget_usd  double precision NOT NULL,
  sim_budget_usd    double precision NOT NULL,
  litellm_team_id   text,
  platform_commit   text,
  plan_commit       text,
  estimate          jsonb NOT NULL,
  status            text NOT NULL CHECK (status IN ('created', 'running', 'done', 'cancelled')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  cancelled_at      timestamptz
);
CREATE INDEX experiments_created ON experiments (created_at DESC);

-- One row per attempt at one (experiment, task, config, repeat) slot. A re-run is a new row
-- with the next attempt number; no row is ever deleted or overwritten once reported.
CREATE TABLE trials (
  id               text PRIMARY KEY,
  experiment_id    text NOT NULL REFERENCES experiments (id),
  task_sha256      text NOT NULL REFERENCES tasks (sha256),
  config_hash      text NOT NULL REFERENCES configs (hash),
  repeat_index     integer NOT NULL CHECK (repeat_index >= 0),
  attempt          integer NOT NULL CHECK (attempt >= 1),
  seq              integer NOT NULL,
  harness          text NOT NULL,
  status           text NOT NULL CHECK (status IN
                     ('queued', 'claimed', 'running', 'done', 'infra_failed', 'abandoned', 'cancelled')),
  worker_id        text,
  claimed_at       timestamptz,
  heartbeat_at     timestamptz,
  finished_at      timestamptz,
  reported_at      timestamptz,
  agent_key_token  text,
  sim_key_token    text,
  keys_revoked_at  timestamptz,
  spec             jsonb,
  folder           text,
  label            text,
  end_state        text,
  runner_report    jsonb,
  result           jsonb,
  cost_usd         double precision,
  sim_cost_usd     double precision,
  input_tokens     integer,
  output_tokens    integer,
  model_calls      integer,
  proxy_complete   boolean,
  wall_s           double precision,
  files            jsonb,
  problems         jsonb NOT NULL DEFAULT '[]',
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, task_sha256, config_hash, repeat_index, attempt)
);
-- The claim query: the next queued trial for a harness.
CREATE INDEX trials_claim ON trials (harness, seq, attempt) WHERE status = 'queued';
-- The lapse sweep: leases with no recent heartbeat.
CREATE INDEX trials_lease ON trials (heartbeat_at) WHERE status IN ('claimed', 'running');
-- Keys still to revoke after a failed revoke call.
CREATE INDEX trials_unrevoked ON trials (finished_at)
  WHERE keys_revoked_at IS NULL AND agent_key_token IS NOT NULL;
CREATE INDEX trials_experiment ON trials (experiment_id, status);
CREATE INDEX trials_experiment_config_task ON trials (experiment_id, config_hash, task_sha256);
-- The estimate's history: finished trials of one config and task.
CREATE INDEX trials_history ON trials (config_hash, task_sha256) WHERE status = 'done';

-- Spans as reported (contract v2, OTLP JSON), with the fields the trace view and failure
-- analysis query pulled out. `raw` is the span as the worker sent it.
CREATE TABLE spans (
  trial_id       text NOT NULL REFERENCES trials (id),
  span_id        text NOT NULL,
  parent_span_id text,
  name           text NOT NULL,
  kind           smallint NOT NULL,
  start_ns       numeric(20, 0) NOT NULL,
  end_ns         numeric(20, 0) NOT NULL,
  status_code    smallint NOT NULL,
  attributes     jsonb NOT NULL,
  raw            jsonb NOT NULL,
  PRIMARY KEY (trial_id, span_id)
);
CREATE INDEX spans_trial_start ON spans (trial_id, start_ns);
CREATE INDEX spans_name ON spans (name);
CREATE INDEX spans_tool ON spans ((attributes ->> 'gen_ai.tool.name')) WHERE name LIKE 'execute_tool %';

-- Grading is its own step after the trial (R14), so a grader fix re-grades without re-running.
CREATE TABLE grades (
  id             bigserial PRIMARY KEY,
  trial_id       text NOT NULL REFERENCES trials (id),
  grader_id      text NOT NULL,
  grader_version text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('exact', 'unit', 'state', 'judge')),
  verdict        text,
  score          double precision,
  evidence       jsonb NOT NULL DEFAULT '[]',
  judge_model    text,
  run_index      integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX grades_trial ON grades (trial_id);

-- Imported read-only from labels/<set>.jsonl, which stay the source (R14). line_sha256 makes
-- the import idempotent. No foreign key: a label file may name trials from another database.
CREATE TABLE labels (
  id          bigserial PRIMARY KEY,
  trial_id    text NOT NULL,
  criterion   text NOT NULL,
  value       text NOT NULL CHECK (value IN ('yes', 'no', 'unsure')),
  label_set   text NOT NULL CHECK (label_set IN ('tuning', 'heldout', 'final')),
  note        text,
  labelled_at timestamptz NOT NULL,
  source      text NOT NULL,
  line_sha256 text NOT NULL UNIQUE
);
CREATE INDEX labels_set_trial ON labels (label_set, trial_id);
