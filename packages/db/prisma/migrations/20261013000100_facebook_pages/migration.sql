BEGIN;
SET LOCAL lock_timeout = '10s';

-- Meta allows one app subscription per Page, so at most one live FeedBouncer
-- connection may own a Facebook Page across all tenants. Disconnected
-- (revoked) rows keep their history and do not count.
CREATE UNIQUE INDEX connection_facebook_live_external_account_id_key
  ON connection (external_account_id)
  WHERE platform = 'facebook' AND status <> 'revoked';

ALTER TABLE comment
  ADD COLUMN is_own_account boolean NOT NULL DEFAULT false,
  ADD COLUMN permalink text,
  ADD COLUMN platform_synced_at timestamptz(3),
  ADD CONSTRAINT comment_permalink_check
    CHECK (permalink IS NULL OR (char_length(permalink) <= 2048 AND permalink LIKE 'https://%'));

CREATE TABLE oauth_grant (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  platform text NOT NULL,
  initiated_by_user_id uuid NOT NULL,
  reconnect_connection_id uuid,
  encrypted_user_token bytea NOT NULL,
  granted_scopes text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT oauth_grant_pkey PRIMARY KEY (id),
  CONSTRAINT oauth_grant_platform_check CHECK (
    platform IN ('facebook', 'instagram', 'tiktok', 'youtube', 'threads', 'linkedin', 'x', 'bluesky')),
  CONSTRAINT oauth_grant_expires_at_check CHECK (expires_at <= created_at + interval '1 hour'),
  CONSTRAINT oauth_grant_granted_scopes_check
    CHECK (cardinality(granted_scopes) <= 100 AND array_position(granted_scopes, NULL) IS NULL),
  CONSTRAINT oauth_grant_organization_id_brand_id_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT oauth_grant_initiated_by_user_id_fkey FOREIGN KEY (initiated_by_user_id)
    REFERENCES app_user (id) ON DELETE CASCADE,
  CONSTRAINT oauth_grant_reconnect_connection_id_fkey FOREIGN KEY (organization_id, brand_id, reconnect_connection_id)
    REFERENCES connection (organization_id, brand_id, id) ON DELETE CASCADE
);
CREATE INDEX oauth_grant_brand_id_idx ON oauth_grant (brand_id);
CREATE INDEX oauth_grant_initiated_by_user_id_idx ON oauth_grant (initiated_by_user_id);
CREATE INDEX oauth_grant_reconnect_connection_id_idx ON oauth_grant (reconnect_connection_id)
  WHERE reconnect_connection_id IS NOT NULL;
CREATE INDEX oauth_grant_expires_at_idx ON oauth_grant (expires_at);
CREATE TRIGGER oauth_grant_set_updated_at_trg BEFORE UPDATE ON oauth_grant
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

CREATE TABLE moderation_action (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  comment_id uuid NOT NULL,
  kind text NOT NULL,
  actor_type text NOT NULL,
  actor_user_id uuid,
  rule_id uuid,
  request_key text NOT NULL,
  reply_text text,
  status text NOT NULL DEFAULT 'pending',
  outcome_code text,
  platform_ref text,
  undo_kind text,
  reverses_action_id uuid,
  completed_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT moderation_action_pkey PRIMARY KEY (id),
  CONSTRAINT moderation_action_brand_id_id_key UNIQUE (brand_id, id),
  CONSTRAINT moderation_action_organization_id_request_key_key UNIQUE (organization_id, request_key),
  CONSTRAINT moderation_action_kind_check CHECK (kind IN
    ('hide', 'unhide', 'delete', 'ban_author', 'unban_author', 'public_reply', 'private_reply')),
  CONSTRAINT moderation_action_actor_type_check CHECK (actor_type IN ('user', 'rule', 'classifier', 'system')),
  CONSTRAINT moderation_action_status_check CHECK (status IN ('pending', 'applied', 'noop', 'not_eligible', 'failed')),
  CONSTRAINT moderation_action_request_key_check CHECK (request_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT moderation_action_reply_text_check CHECK (
    (kind IN ('public_reply', 'private_reply')) = (reply_text IS NOT NULL)
    AND (reply_text IS NULL OR char_length(reply_text) BETWEEN 1 AND 8000)),
  CONSTRAINT moderation_action_outcome_code_check
    CHECK (outcome_code IS NULL OR outcome_code ~ '^[a-z][a-z0-9_]{0,62}$'),
  CONSTRAINT moderation_action_platform_ref_check
    CHECK (platform_ref IS NULL OR (char_length(platform_ref) BETWEEN 1 AND 255)),
  CONSTRAINT moderation_action_undo_kind_check CHECK (undo_kind IS NULL OR undo_kind IN ('hide', 'unhide', 'ban_author', 'unban_author')),
  CONSTRAINT moderation_action_completed_check CHECK ((status = 'pending') = (completed_at IS NULL)),
  CONSTRAINT moderation_action_organization_id_brand_id_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT moderation_action_connection_id_fkey FOREIGN KEY (organization_id, brand_id, connection_id)
    REFERENCES connection (organization_id, brand_id, id) ON DELETE CASCADE,
  CONSTRAINT moderation_action_comment_id_fkey FOREIGN KEY (brand_id, comment_id)
    REFERENCES comment (brand_id, id) ON DELETE CASCADE,
  CONSTRAINT moderation_action_actor_user_id_fkey FOREIGN KEY (actor_user_id)
    REFERENCES app_user (id) ON DELETE SET NULL,
  CONSTRAINT moderation_action_rule_id_fkey FOREIGN KEY (brand_id, rule_id)
    REFERENCES rule (brand_id, id) ON DELETE SET NULL (rule_id),
  CONSTRAINT moderation_action_reverses_action_id_fkey FOREIGN KEY (brand_id, reverses_action_id)
    REFERENCES moderation_action (brand_id, id) ON DELETE SET NULL (reverses_action_id)
);
CREATE INDEX moderation_action_brand_id_idx ON moderation_action (brand_id);
CREATE INDEX moderation_action_connection_id_idx ON moderation_action (connection_id);
CREATE INDEX moderation_action_comment_id_idx ON moderation_action (comment_id, created_at);
CREATE INDEX moderation_action_actor_user_id_idx ON moderation_action (actor_user_id) WHERE actor_user_id IS NOT NULL;
CREATE INDEX moderation_action_rule_id_idx ON moderation_action (rule_id) WHERE rule_id IS NOT NULL;
CREATE INDEX moderation_action_reverses_action_id_idx ON moderation_action (reverses_action_id)
  WHERE reverses_action_id IS NOT NULL;
CREATE UNIQUE INDEX moderation_action_private_reply_once_key ON moderation_action (comment_id)
  WHERE kind = 'private_reply' AND status IN ('pending', 'applied');
CREATE TRIGGER moderation_action_set_updated_at_trg BEFORE UPDATE ON moderation_action
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

COMMIT;
