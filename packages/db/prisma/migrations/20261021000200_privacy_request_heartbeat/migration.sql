-- Liveness of a running privacy request, kept apart from started_at so the real start time survives.
ALTER TABLE privacy_request ADD COLUMN heartbeat_at timestamptz(3);
UPDATE privacy_request SET heartbeat_at = started_at WHERE status = 'running';
