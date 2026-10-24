BEGIN;
SET LOCAL lock_timeout = '10s';

-- 1. tiktok_ads platform (mirrors PLATFORMS in packages/connectors/src/types.ts)
ALTER TABLE connection DROP CONSTRAINT connection_platform_check,
  ADD CONSTRAINT connection_platform_check CHECK (platform IN ('facebook','instagram','tiktok','youtube','threads','linkedin','x','bluesky','meta_ads','tiktok_ads'));
ALTER TABLE oauth_state DROP CONSTRAINT oauth_state_platform_check,
  ADD CONSTRAINT oauth_state_platform_check CHECK (platform IN ('facebook','instagram','tiktok','youtube','threads','linkedin','x','bluesky','meta_ads','tiktok_ads'));
ALTER TABLE oauth_grant DROP CONSTRAINT oauth_grant_platform_check,
  ADD CONSTRAINT oauth_grant_platform_check CHECK (platform IN ('facebook','instagram','tiktok','youtube','threads','linkedin','x','bluesky','meta_ads','tiktok_ads'));
ALTER TABLE job_ledger DROP CONSTRAINT job_ledger_platform_check,
  ADD CONSTRAINT job_ledger_platform_check CHECK (platform IN ('facebook','instagram','tiktok','youtube','threads','linkedin','x','bluesky','meta_ads','tiktok_ads'));

-- 2. Connection-level poll state (TikTok video discovery; TikTok advertiser comment listing).
CREATE TABLE connection_poll (
  connection_id     uuid NOT NULL,
  organization_id   uuid NOT NULL,
  brand_id          uuid NOT NULL,
  kind              text NOT NULL,
  high_water_at     timestamptz(3),
  pass_started_at   timestamptz(3),
  pass_newest_at    timestamptz(3),
  resume_page       integer,
  resume_cursor     text,
  last_polled_at    timestamptz(3),
  last_full_scan_at timestamptz(3),
  next_poll_at      timestamptz(3) NOT NULL DEFAULT now(),
  last_error_code   text,
  created_at        timestamptz(3) NOT NULL DEFAULT now(),
  updated_at        timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT connection_poll_pkey PRIMARY KEY (connection_id),
  CONSTRAINT connection_poll_connection_fkey FOREIGN KEY (organization_id, brand_id, connection_id)
    REFERENCES connection (organization_id, brand_id, id) ON DELETE CASCADE,
  CONSTRAINT connection_poll_kind_check CHECK (kind IN ('tiktok_videos','tiktok_ad_comments')),
  CONSTRAINT connection_poll_resume_page_check CHECK (resume_page IS NULL OR resume_page BETWEEN 2 AND 100000),
  CONSTRAINT connection_poll_resume_cursor_check CHECK (resume_cursor IS NULL OR resume_cursor ~ '^\d{1,16}$'),
  CONSTRAINT connection_poll_last_error_code_check CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$')
);
CREATE INDEX connection_poll_organization_id_brand_id_connection_id_idx
  ON connection_poll (organization_id, brand_id, connection_id);
CREATE INDEX connection_poll_next_poll_at_idx ON connection_poll (next_poll_at);
CREATE TRIGGER connection_poll_set_updated_at_trg BEFORE UPDATE ON connection_poll
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- 3. Which scopes a scope-missing reconnect needs. The status_reason check is a format
-- regex, so 'oauth_scope_missing' already passes it.
ALTER TABLE connection ADD COLUMN missing_scopes text[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT connection_missing_scopes_check CHECK (cardinality(missing_scopes) <= 20);

-- 4. Rule scoping by origin.
ALTER TABLE rule ADD COLUMN applies_to text NOT NULL DEFAULT 'all',
  ADD CONSTRAINT rule_applies_to_check CHECK (applies_to IN ('all','organic','ad'));

COMMIT;
