-- Run controls and lineage, from Rishi's guide review (4 Nov): D32 (random order, futility and
-- guard pauses), D34 (lineage, baseline reuse), D35 (two arms), D37 (a config error pauses its
-- arm only), and platform item 8 (estimates from history, with the live workers per harness).

-- D34: a config may name the config it was forked from. Lineage is not behaviour, so it is not
-- in the config hash; the first post of a config's content records its parent.
ALTER TABLE configs ADD COLUMN parent_hash text REFERENCES configs (hash);
CREATE INDEX configs_parent ON configs (parent_hash) WHERE parent_hash IS NOT NULL;

-- D34: an experiment may name its parent and ask to reuse the parent's arm-A trials;
-- `baseline_decision` says whether that applied and why. D32: `order_seed` is the seed of the
-- claim-order shuffle; `futility` is the resolved rule ({enabled, after, min_passed}).
-- `spend_guard_at`: the projected-spend guard pauses once per experiment.
ALTER TABLE experiments
  ADD COLUMN parent_experiment_id text REFERENCES experiments (id),
  ADD COLUMN reuse_baseline boolean NOT NULL DEFAULT false,
  ADD COLUMN baseline_decision text,
  ADD COLUMN order_seed bigint,
  ADD COLUMN futility jsonb,
  ADD COLUMN spend_guard_at timestamptz;
CREATE INDEX experiments_parent ON experiments (parent_experiment_id) WHERE parent_experiment_id IS NOT NULL;

-- D32: each trial's place in the seeded, arm-interleaved claim order. A re-queued attempt keeps
-- its slot's place. Trials made before this migration keep their old order (seq).
ALTER TABLE trials ADD COLUMN order_index integer;
UPDATE trials SET order_index = seq;
ALTER TABLE trials ALTER COLUMN order_index SET NOT NULL;
DROP INDEX trials_claim;
CREATE INDEX trials_claim ON trials (harness, order_index, attempt) WHERE status = 'queued';
-- The estimate's history by harness and model (item 8).
CREATE INDEX trials_history_harness ON trials (harness) WHERE status = 'done';

-- D35, D37: one row per arm, holding what can change while the experiment runs (the frozen plan
-- stays on `experiments`). An arm is paused by an infra:config_error report or by hand; claims
-- skip a paused arm. `reused_trial_ids` (D34): arm A's trials taken from the parent instead of
-- being run again. `futility_checked_at` (D32): the futility check runs once per arm.
CREATE TABLE experiment_arms (
  experiment_id       text NOT NULL REFERENCES experiments (id),
  config_hash         text NOT NULL REFERENCES configs (hash),
  arm                 text NOT NULL,
  position            integer NOT NULL,
  reused_trial_ids    text[] NOT NULL DEFAULT '{}',
  paused_at           timestamptz,
  paused_reason       text,
  paused_fix          text,
  resumed_at          timestamptz,
  futility_checked_at timestamptz,
  PRIMARY KEY (experiment_id, config_hash),
  UNIQUE (experiment_id, arm)
);
INSERT INTO experiment_arms (experiment_id, config_hash, arm, position)
SELECT e.id, c.hash, chr(64 + c.ord::int), c.ord::int - 1
FROM experiments e, unnest(e.config_hashes) WITH ORDINALITY AS c (hash, ord);

-- What the trial rows cannot show: pauses and resumes (by hand, futility, guards, an arm's config
-- error), stops and the baseline decision, each with its time and plain-words detail. Events from
-- trial rows (claims, failures, re-queues) are still derived, not stored.
CREATE TABLE experiment_events (
  id            bigserial PRIMARY KEY,
  experiment_id text NOT NULL REFERENCES experiments (id),
  at            timestamptz NOT NULL DEFAULT now(),
  kind          text NOT NULL,
  config_hash   text,
  trial_id      text,
  attempt       integer,
  detail        text NOT NULL,
  data          jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX experiment_events_experiment ON experiment_events (experiment_id, at);

-- Item 8: workers seen recently, per harness, from their claims (a 204 included) and heartbeats,
-- so the estimate's time divides by the real concurrency.
CREATE TABLE workers (
  worker_id    text PRIMARY KEY,
  harness      text NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workers_harness_seen ON workers (harness, last_seen_at);
