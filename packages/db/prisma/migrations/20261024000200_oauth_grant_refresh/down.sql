ALTER TABLE oauth_grant DROP CONSTRAINT oauth_grant_refresh_expires_at_check,
  DROP COLUMN refresh_expires_at,
  DROP COLUMN encrypted_refresh_token,
  DROP COLUMN user_access_expires_at;
