-- D27: the simulator's temperature is optional. Null means it is not sent, so the model's
-- default applies (Haiku 5.5 refuses any temperature); the reply cache gives repeatability.
-- A null-temperature simulator is its own cache scope: claims select with IS NOT DISTINCT FROM.
ALTER TABLE sim_replies ALTER COLUMN temperature DROP NOT NULL;
