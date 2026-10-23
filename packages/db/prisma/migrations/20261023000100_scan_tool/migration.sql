-- Free ad-comment scan tool: anonymous visitors, their short-lived OAuth state
-- and grants, and the scans themselves. Nothing here references organization,
-- brand, connection or comment. User tokens are stored only as sealed blobs and
-- are nulled when a scan reaches a terminal status. See packages/scan.
BEGIN;
SET LOCAL lock_timeout = '10s';

-- One row per browser, identified by the sha256 of its cookie token.
CREATE TABLE scan_visitor (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL,
  last_seen_at timestamptz(3) NOT NULL DEFAULT now(),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT scan_visitor_pkey PRIMARY KEY (id),
  CONSTRAINT scan_visitor_token_hash_key UNIQUE (token_hash),
  CONSTRAINT scan_visitor_token_hash_check CHECK (octet_length(token_hash) = 32)
);
CREATE TRIGGER scan_visitor_set_updated_at_trg BEFORE UPDATE ON scan_visitor
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- A pending OAuth redirect, keyed by the hash of its state. Only inserted and
-- deleted, so one event timestamp (created_at) and no updated_at.
CREATE TABLE scan_oauth_state (
  state_hash bytea NOT NULL,
  visitor_id uuid NOT NULL,
  key_id text NOT NULL,
  encrypted_pkce_verifier bytea NOT NULL,
  expires_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT scan_oauth_state_pkey PRIMARY KEY (state_hash),
  CONSTRAINT scan_oauth_state_state_hash_check CHECK (octet_length(state_hash) = 32),
  CONSTRAINT scan_oauth_state_visitor_id_fkey FOREIGN KEY (visitor_id)
    REFERENCES scan_visitor (id) ON DELETE CASCADE
);
CREATE INDEX scan_oauth_state_visitor_id_idx ON scan_oauth_state (visitor_id);
CREATE INDEX scan_oauth_state_expires_at_idx ON scan_oauth_state (expires_at);

-- The result of a completed OAuth redirect: a sealed user token and the pages
-- the visitor may pick from. Spent by the scan created from it.
CREATE TABLE scan_grant (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  visitor_id uuid NOT NULL,
  fb_user_hash bytea NOT NULL,
  key_id text NOT NULL,
  encrypted_user_token bytea NOT NULL,
  granted_scopes text[] NOT NULL DEFAULT '{}',
  pages jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT scan_grant_pkey PRIMARY KEY (id),
  CONSTRAINT scan_grant_fb_user_hash_check CHECK (octet_length(fb_user_hash) = 32),
  CONSTRAINT scan_grant_pages_check CHECK (jsonb_typeof(pages) = 'array'),
  CONSTRAINT scan_grant_visitor_id_fkey FOREIGN KEY (visitor_id)
    REFERENCES scan_visitor (id) ON DELETE CASCADE
);
CREATE INDEX scan_grant_visitor_id_idx ON scan_grant (visitor_id);
CREATE INDEX scan_grant_expires_at_idx ON scan_grant (expires_at);
CREATE TRIGGER scan_grant_set_updated_at_trg BEFORE UPDATE ON scan_grant
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- One scan of one Facebook page. The sealed token lives only while the scan is
-- queued or running. share_token_hash is the sha256 of a public share link token.
CREATE TABLE scan (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  visitor_id uuid NOT NULL,
  page_external_id text NOT NULL,
  page_name text NOT NULL,
  ig_user_id text,
  status text NOT NULL DEFAULT 'queued',
  failure_reason text,
  attempt integer NOT NULL DEFAULT 0,
  key_id text,
  encrypted_user_token bytea,
  result jsonb,
  share_token_hash bytea,
  started_at timestamptz(3),
  finished_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT scan_pkey PRIMARY KEY (id),
  CONSTRAINT scan_share_token_hash_key UNIQUE (share_token_hash),
  CONSTRAINT scan_page_external_id_check CHECK (page_external_id ~ '^\d{1,32}$'),
  CONSTRAINT scan_share_token_hash_check CHECK (share_token_hash IS NULL OR octet_length(share_token_hash) = 32),
  CONSTRAINT scan_status_check CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  CONSTRAINT scan_failure_reason_check CHECK (failure_reason IS NULL OR failure_reason IN (
    'access_revoked', 'missing_permissions', 'insufficient_page_role', 'rate_limited',
    'platform_unavailable', 'classifier_unavailable', 'timeout', 'internal')),
  CONSTRAINT scan_attempt_check CHECK (attempt >= 0),
  CONSTRAINT scan_token_until_finished_check CHECK (
    (status IN ('completed', 'failed')) = (encrypted_user_token IS NULL)),
  CONSTRAINT scan_completed_has_result_check CHECK (status <> 'completed' OR result IS NOT NULL),
  CONSTRAINT scan_visitor_id_fkey FOREIGN KEY (visitor_id)
    REFERENCES scan_visitor (id) ON DELETE CASCADE
);
CREATE INDEX scan_visitor_id_created_at_idx ON scan (visitor_id, created_at DESC);
CREATE UNIQUE INDEX scan_one_active_per_page_idx ON scan (page_external_id)
  WHERE status IN ('queued', 'running');
CREATE INDEX scan_created_at_idx ON scan (created_at);
CREATE TRIGGER scan_set_updated_at_trg BEFORE UPDATE ON scan
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

COMMIT;
