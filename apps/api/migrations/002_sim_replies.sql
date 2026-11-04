-- D22: the simulated client's replies, cached by exact conversation state and reused by later
-- trials. `key` is evals_adapter.sim.cache_key: a hash over the task (id and version), the
-- simulator model, temperature, token cap, prompt and the visible transcript, so one key is one
-- conversation state. The other columns are what a claim selects by: the same task, simulator
-- model, settings and prompt. Workers report new replies in out/sim_replies.jsonl; the first
-- reply stored for a key is kept. The agent's own calls are never cached.
CREATE TABLE sim_replies (
  key               text PRIMARY KEY,
  task_sha256       text NOT NULL REFERENCES tasks (sha256),
  sim_model         text NOT NULL,
  temperature       double precision NOT NULL,
  max_output_tokens integer NOT NULL,
  prompt_sha256     text NOT NULL,
  reply             text NOT NULL,
  usage             jsonb,
  trial_id          text NOT NULL REFERENCES trials (id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sim_replies_lookup ON sim_replies (task_sha256, sim_model, temperature, max_output_tokens, prompt_sha256);
