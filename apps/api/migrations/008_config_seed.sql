-- D39: a config may seed memory and skills, in contract v2's seed shape. The claim copies it
-- into the trial's spec.seed. Configs made before this had no seed, so they get empty lists;
-- an empty seed is left out of the config hash, so their hashes still match their content.
ALTER TABLE configs ADD COLUMN seed jsonb NOT NULL DEFAULT '{"memory": [], "skills": []}';
