BEGIN;
SET LOCAL lock_timeout = '10s';

-- 1. Threads post discovery poll kind.
ALTER TABLE connection_poll DROP CONSTRAINT connection_poll_kind_check,
  ADD CONSTRAINT connection_poll_kind_check CHECK (kind IN ('tiktok_videos','tiktok_ad_comments','threads_posts'));

-- 2. One live FeedBouncer connection per Threads account across all tenants, because Meta
-- allows one app subscription per account. Disconnected (revoked) rows keep their history
-- and do not count.
CREATE UNIQUE INDEX connection_threads_live_account_key
  ON connection (external_account_id)
  WHERE platform = 'threads' AND status <> 'revoked';

-- 3. Reply webhooks that arrived before their post is known; resolved on the next poll.
CREATE TABLE threads_pending_reply (
  organization_id    uuid NOT NULL,
  brand_id           uuid NOT NULL,
  connection_id      uuid NOT NULL,
  external_id        text NOT NULL,
  source_external_id text NOT NULL,
  received_at        timestamptz(3) NOT NULL,
  attempts           integer NOT NULL DEFAULT 0,
  created_at         timestamptz(3) NOT NULL DEFAULT now(),
  updated_at         timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT threads_pending_reply_pkey PRIMARY KEY (connection_id, external_id),
  CONSTRAINT threads_pending_reply_connection_id_fkey FOREIGN KEY (organization_id, brand_id, connection_id)
    REFERENCES connection (organization_id, brand_id, id) ON DELETE CASCADE,
  CONSTRAINT threads_pending_reply_external_id_check CHECK (external_id ~ '^\d{1,32}$'),
  CONSTRAINT threads_pending_reply_source_external_id_check CHECK (source_external_id ~ '^\d{1,32}$'),
  CONSTRAINT threads_pending_reply_attempts_check CHECK (attempts BETWEEN 0 AND 100)
);
CREATE INDEX threads_pending_reply_source_idx ON threads_pending_reply (connection_id, source_external_id);
CREATE INDEX threads_pending_reply_org_idx ON threads_pending_reply (organization_id, brand_id);
CREATE TRIGGER threads_pending_reply_set_updated_at_trg BEFORE UPDATE ON threads_pending_reply
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- 4. Source ownership check: NULL = unchecked, false = foreign.
ALTER TABLE source_poll ADD COLUMN owner_verified boolean;

-- 5. Visible action deferral.
ALTER TABLE moderation_action
  ADD COLUMN deferred_until timestamptz(3),
  ADD COLUMN deferred_code text,
  ADD CONSTRAINT moderation_action_deferred_code_check CHECK (deferred_code ~ '^[a-z][a-z0-9_]{0,62}$'),
  ADD CONSTRAINT moderation_action_deferred_check CHECK ((deferred_until IS NULL) = (deferred_code IS NULL));

COMMIT;
