ALTER TABLE processed_job DROP COLUMN completed_at;
DROP TABLE oauth_state;
ALTER TABLE connection DROP CONSTRAINT connection_granted_scopes_check;
ALTER TABLE connection DROP COLUMN granted_scopes;
