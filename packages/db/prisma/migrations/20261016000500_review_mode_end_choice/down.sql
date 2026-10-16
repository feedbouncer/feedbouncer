ALTER TABLE connection
  DROP CONSTRAINT connection_review_mode_ended_pending_check,
  DROP COLUMN review_mode_ended_pending;
