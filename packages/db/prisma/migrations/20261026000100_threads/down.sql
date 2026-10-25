ALTER TABLE moderation_action
  DROP CONSTRAINT moderation_action_deferred_check,
  DROP CONSTRAINT moderation_action_deferred_code_check,
  DROP COLUMN deferred_code,
  DROP COLUMN deferred_until;
ALTER TABLE source_poll DROP COLUMN owner_verified;
DROP TABLE threads_pending_reply;
DROP INDEX connection_threads_live_account_key;
-- Destructive rollback: threads_posts poll rows cannot satisfy the restored check, so they are deleted.
DELETE FROM connection_poll WHERE kind = 'threads_posts';
ALTER TABLE connection_poll DROP CONSTRAINT connection_poll_kind_check,
  ADD CONSTRAINT connection_poll_kind_check CHECK (kind IN ('tiktok_videos','tiktok_ad_comments'));
