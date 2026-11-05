-- G3 (review, 5 Nov): what an abandoned attempt spent. Such an attempt never reports, so the lease
-- sweep reads its keys' spend from LiteLLM's spend log before revoking them and stores it in
-- cost_usd and sim_cost_usd, as a report would. spend_unknown marks an attempt whose spend LiteLLM
-- could not give: its cost stays null, which is unknown, not zero.
ALTER TABLE trials ADD COLUMN spend_unknown boolean NOT NULL DEFAULT false;

-- Attempts abandoned before this migration had their keys revoked with their spend never read, so
-- it is unknown. A shipped example's rows are never changed (SP7).
UPDATE trials t SET spend_unknown = true
WHERE t.status = 'abandoned' AND t.cost_usd IS NULL AND t.agent_key_token IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM experiments ex WHERE ex.id = t.experiment_id AND ex.example_name IS NOT NULL);
