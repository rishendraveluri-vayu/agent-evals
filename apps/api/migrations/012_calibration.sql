-- SP6, D44: an A/A calibration run puts one config on both arms, to measure the setup's own noise.
-- It is allowed only when the experiment is marked as one; otherwise the same config twice stays
-- refused (A30). Its arm B trials are told apart from arm A's by repeat_index: arm A has repeats
-- 0 to n - 1 and arm B n to 2n - 1 (the UI's armIndexOf and the export's armOf already read it so).
ALTER TABLE experiments ADD COLUMN calibration boolean NOT NULL DEFAULT false;
ALTER TABLE experiments ADD CONSTRAINT experiments_calibration_arms CHECK (
  calibration = (cardinality(config_hashes) = 2 AND config_hashes[1] = config_hashes[2])
);

-- An arm is (experiment, arm letter), no longer (experiment, config): in a calibration run both
-- arms hold the same config. UNIQUE (experiment_id, arm) from 005 already holds.
ALTER TABLE experiment_arms DROP CONSTRAINT experiment_arms_pkey;
ALTER TABLE experiment_arms ADD PRIMARY KEY (experiment_id, arm);
CREATE INDEX experiment_arms_config ON experiment_arms (experiment_id, config_hash);
