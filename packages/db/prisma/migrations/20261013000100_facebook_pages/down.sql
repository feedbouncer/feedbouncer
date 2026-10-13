DROP TABLE moderation_action;
DROP TABLE oauth_grant;
ALTER TABLE comment DROP CONSTRAINT comment_permalink_check;
ALTER TABLE comment DROP COLUMN platform_synced_at, DROP COLUMN permalink, DROP COLUMN is_own_account;
DROP INDEX connection_facebook_live_external_account_id_key;
