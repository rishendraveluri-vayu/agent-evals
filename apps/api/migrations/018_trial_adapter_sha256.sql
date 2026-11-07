-- D85 (7 Nov): which adapter code ran each attempt. A config's hash covers adapter_version, the
-- harness worker's pyproject version, which was never bumped, so one config hash ran different
-- adapter code. The worker hashes the adapter's source files at startup (the harness package and
-- evals_adapter, workers/adapterlib/src/evals_adapter/source_hash.py) and sends the hash with every
-- claim; the claim stores it here. It is kept off the config hash, so existing config hashes and the
-- shipped examples' stay as they are. Null on every attempt claimed before this column, the shipped
-- examples' among them, and on a claim from a worker that could not work it out.
ALTER TABLE trials ADD COLUMN adapter_sha256 text
  CONSTRAINT trials_adapter_sha256_ref CHECK (adapter_sha256 ~ '^sha256:[0-9a-f]{64}$');
