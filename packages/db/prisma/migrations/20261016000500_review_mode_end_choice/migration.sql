BEGIN;
ALTER TABLE connection
  ADD COLUMN review_mode_ended_pending text,
  ADD CONSTRAINT connection_review_mode_ended_pending_check CHECK (
    review_mode_ended_pending IS NULL
    OR (review_mode_ended_pending IN ('leave', 'dismiss', 'approve') AND review_mode_ended_at IS NOT NULL));
COMMIT;
