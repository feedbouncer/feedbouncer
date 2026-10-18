-- VALIDATE CONSTRAINT marks the constraint validated in the catalog, which is a schema
-- change even though it rewrites no data. Undo it by dropping and re-adding as NOT VALID.
BEGIN;

ALTER TABLE job_ledger
  DROP CONSTRAINT job_ledger_claimed_at_check,
  ADD CONSTRAINT job_ledger_claimed_at_check CHECK ((first_claimed_at IS NULL) = (last_claimed_at IS NULL)) NOT VALID;

ALTER TABLE comment_classification
  DROP CONSTRAINT comment_classification_input_tokens_check,
  DROP CONSTRAINT comment_classification_output_tokens_check,
  DROP CONSTRAINT comment_classification_cache_read_tokens_check,
  ADD CONSTRAINT comment_classification_input_tokens_check CHECK (input_tokens IS NULL OR input_tokens >= 0) NOT VALID,
  ADD CONSTRAINT comment_classification_output_tokens_check CHECK (output_tokens IS NULL OR output_tokens >= 0) NOT VALID,
  ADD CONSTRAINT comment_classification_cache_read_tokens_check CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0) NOT VALID;

ALTER TABLE policy_evaluation
  DROP CONSTRAINT policy_evaluation_input_tokens_check,
  DROP CONSTRAINT policy_evaluation_output_tokens_check,
  DROP CONSTRAINT policy_evaluation_cache_read_tokens_check,
  ADD CONSTRAINT policy_evaluation_input_tokens_check CHECK (input_tokens IS NULL OR input_tokens >= 0) NOT VALID,
  ADD CONSTRAINT policy_evaluation_output_tokens_check CHECK (output_tokens IS NULL OR output_tokens >= 0) NOT VALID,
  ADD CONSTRAINT policy_evaluation_cache_read_tokens_check CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0) NOT VALID;

COMMIT;
