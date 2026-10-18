-- Evaluation instrumentation: when a job was first and last claimed, and the token usage of each
-- classifier and policy evaluation.
BEGIN;

SET LOCAL lock_timeout = '10s';

ALTER TABLE job_ledger
  ADD COLUMN first_claimed_at timestamptz(3),
  ADD COLUMN last_claimed_at timestamptz(3),
  ADD CONSTRAINT job_ledger_claimed_at_check CHECK ((first_claimed_at IS NULL) = (last_claimed_at IS NULL)) NOT VALID;

ALTER TABLE comment_classification
  ADD COLUMN input_tokens integer,
  ADD COLUMN output_tokens integer,
  ADD COLUMN cache_read_tokens integer,
  ADD CONSTRAINT comment_classification_input_tokens_check CHECK (input_tokens IS NULL OR input_tokens >= 0) NOT VALID,
  ADD CONSTRAINT comment_classification_output_tokens_check CHECK (output_tokens IS NULL OR output_tokens >= 0) NOT VALID,
  ADD CONSTRAINT comment_classification_cache_read_tokens_check CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0) NOT VALID;

ALTER TABLE policy_evaluation
  ADD COLUMN input_tokens integer,
  ADD COLUMN output_tokens integer,
  ADD COLUMN cache_read_tokens integer,
  ADD CONSTRAINT policy_evaluation_input_tokens_check CHECK (input_tokens IS NULL OR input_tokens >= 0) NOT VALID,
  ADD CONSTRAINT policy_evaluation_output_tokens_check CHECK (output_tokens IS NULL OR output_tokens >= 0) NOT VALID,
  ADD CONSTRAINT policy_evaluation_cache_read_tokens_check CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0) NOT VALID;

COMMIT;
