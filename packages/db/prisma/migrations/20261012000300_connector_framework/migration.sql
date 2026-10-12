-- Connector framework: granted OAuth scopes on connection, and short-lived
-- OAuth authorization state (PKCE). Only a SHA-256 of the state and an
-- envelope-encrypted PKCE verifier are stored (packages/connectors/src/pg).
BEGIN;

SET LOCAL lock_timeout = '10s';

ALTER TABLE connection ADD COLUMN granted_scopes text[] NOT NULL DEFAULT '{}';
ALTER TABLE connection ADD CONSTRAINT connection_granted_scopes_check
  CHECK (cardinality(granted_scopes) <= 100 AND array_position(granted_scopes, NULL) IS NULL);

CREATE TABLE oauth_state (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  platform text NOT NULL,
  initiated_by_user_id uuid NOT NULL,
  reconnect_connection_id uuid,
  state_hash bytea NOT NULL,
  encrypted_pkce_verifier bytea NOT NULL,
  redirect_uri text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT oauth_state_pkey PRIMARY KEY (id),
  CONSTRAINT oauth_state_state_hash_key UNIQUE (state_hash),
  CONSTRAINT oauth_state_state_hash_check CHECK (octet_length(state_hash) = 32),
  CONSTRAINT oauth_state_platform_check CHECK (
    platform IN ('facebook', 'instagram', 'tiktok', 'youtube', 'threads', 'linkedin', 'x', 'bluesky')),
  -- Envelope v1 (packages/secrets/src/envelope.ts): version byte 1, bounded size.
  CONSTRAINT oauth_state_encrypted_pkce_verifier_check CHECK (
    octet_length(encrypted_pkce_verifier) BETWEEN 34 AND 4096 AND get_byte(encrypted_pkce_verifier, 0) = 1),
  CONSTRAINT oauth_state_redirect_uri_check CHECK (
    char_length(redirect_uri) BETWEEN 10 AND 2048 AND redirect_uri ~ '^https?://[^[:space:]]+$'),
  CONSTRAINT oauth_state_scopes_check CHECK (
    cardinality(scopes) <= 100 AND array_position(scopes, NULL) IS NULL),
  CONSTRAINT oauth_state_expires_at_check CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '1 hour'),
  CONSTRAINT oauth_state_organization_id_brand_id_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT oauth_state_initiated_by_user_id_fkey FOREIGN KEY (initiated_by_user_id)
    REFERENCES app_user (id) ON DELETE CASCADE,
  CONSTRAINT oauth_state_reconnect_connection_id_fkey FOREIGN KEY (organization_id, brand_id, reconnect_connection_id)
    REFERENCES connection (organization_id, brand_id, id) ON DELETE CASCADE
);
CREATE INDEX oauth_state_brand_id_idx ON oauth_state (brand_id);
CREATE INDEX oauth_state_initiated_by_user_id_idx ON oauth_state (initiated_by_user_id);
CREATE INDEX oauth_state_reconnect_connection_id_idx ON oauth_state (reconnect_connection_id)
  WHERE reconnect_connection_id IS NOT NULL;
CREATE INDEX oauth_state_expires_at_idx ON oauth_state (expires_at);
CREATE TRIGGER oauth_state_set_updated_at_trg BEFORE UPDATE ON oauth_state
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- Webhook dedupe claims (packages/connectors/src/pg/ledger.ts): a claim is only
-- final once completed_at is set; an unfinished claim can be taken over after
-- its lease, so a crashed worker does not swallow the platform's retry.
ALTER TABLE processed_job ADD COLUMN completed_at timestamptz(3);

COMMIT;
