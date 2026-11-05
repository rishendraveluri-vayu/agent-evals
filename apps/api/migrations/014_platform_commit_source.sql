-- G2 (review, 5 Nov): where an experiment's platform_commit came from. 'env' is
-- EVALS_PLATFORM_COMMIT as set; 'git' is the checkout's HEAD, read by the API from the .git that
-- compose mounts read-only, so a plain `docker compose up` records the commit. Either way the
-- working tree is unknown-dirty: the API cannot see uncommitted changes. Null with no commit, and
-- on experiments made before this migration (whose commit, when set, came from the variable).
ALTER TABLE experiments ADD COLUMN platform_commit_source text
  CHECK (platform_commit_source IN ('env', 'git'));
