BEGIN;
SET LOCAL lock_timeout = '10s';

-- A TikTok account is connected with the user token itself, so its grant also keeps
-- the token's expiry and refresh token (sealed like the user token) until connect.
ALTER TABLE oauth_grant ADD COLUMN user_access_expires_at timestamptz(3),
  ADD COLUMN encrypted_refresh_token bytea,
  ADD COLUMN refresh_expires_at timestamptz(3),
  ADD CONSTRAINT oauth_grant_refresh_expires_at_check
    CHECK (refresh_expires_at IS NULL OR encrypted_refresh_token IS NOT NULL);

COMMIT;
