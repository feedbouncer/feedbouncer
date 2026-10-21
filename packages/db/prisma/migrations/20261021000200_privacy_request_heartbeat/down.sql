-- Drops the liveness column added by this migration. Request records are untouched.
ALTER TABLE privacy_request DROP COLUMN heartbeat_at;
