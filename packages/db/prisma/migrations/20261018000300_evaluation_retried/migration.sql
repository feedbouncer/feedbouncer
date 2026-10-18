-- Evaluation instrumentation: whether a model call was only recorded after earlier attempts failed
-- with a retryable error, so their token usage is not in the row.
BEGIN;

SET LOCAL lock_timeout = '10s';

ALTER TABLE comment_classification ADD COLUMN retried boolean NOT NULL DEFAULT false;
ALTER TABLE policy_evaluation ADD COLUMN retried boolean NOT NULL DEFAULT false;

COMMIT;
