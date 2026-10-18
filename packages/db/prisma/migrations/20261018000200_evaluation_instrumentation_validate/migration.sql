-- Validate the evaluation instrumentation constraints. VALIDATE CONSTRAINT takes a lock that
-- allows concurrent writes, which is why it is not part of the migration that adds them.
BEGIN;

ALTER TABLE job_ledger VALIDATE CONSTRAINT job_ledger_claimed_at_check;
ALTER TABLE comment_classification VALIDATE CONSTRAINT comment_classification_input_tokens_check;
ALTER TABLE comment_classification VALIDATE CONSTRAINT comment_classification_output_tokens_check;
ALTER TABLE comment_classification VALIDATE CONSTRAINT comment_classification_cache_read_tokens_check;
ALTER TABLE policy_evaluation VALIDATE CONSTRAINT policy_evaluation_input_tokens_check;
ALTER TABLE policy_evaluation VALIDATE CONSTRAINT policy_evaluation_output_tokens_check;
ALTER TABLE policy_evaluation VALIDATE CONSTRAINT policy_evaluation_cache_read_tokens_check;

COMMIT;
