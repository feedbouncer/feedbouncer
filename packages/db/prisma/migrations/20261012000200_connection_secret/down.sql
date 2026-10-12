DROP TABLE connection_secret;
UPDATE connection SET status = 'error' WHERE status = 'reconnect_required';
ALTER TABLE connection DROP CONSTRAINT connection_status_reason_check;
ALTER TABLE connection DROP COLUMN status_reason;
ALTER TABLE connection DROP CONSTRAINT connection_status_check;
ALTER TABLE connection ADD CONSTRAINT connection_status_check
  CHECK (status IN ('active', 'paused', 'revoked', 'error'));
