BEGIN;
SET LOCAL lock_timeout = '10s';

-- 0. Composite tenant key on source, required by the tenant-scoped FKs below.
ALTER TABLE source ADD CONSTRAINT source_organization_id_brand_id_id_key UNIQUE (organization_id, brand_id, id);

-- 1. meta_ads platform (mirrors PLATFORMS in packages/connectors/src/types.ts)
ALTER TABLE connection DROP CONSTRAINT connection_platform_check,
  ADD CONSTRAINT connection_platform_check CHECK (
    platform IN ('facebook','instagram','tiktok','youtube','threads','linkedin','x','bluesky','meta_ads'));
ALTER TABLE oauth_state DROP CONSTRAINT oauth_state_platform_check,
  ADD CONSTRAINT oauth_state_platform_check CHECK (
    platform IN ('facebook','instagram','tiktok','youtube','threads','linkedin','x','bluesky','meta_ads'));
ALTER TABLE oauth_grant DROP CONSTRAINT oauth_grant_platform_check,
  ADD CONSTRAINT oauth_grant_platform_check CHECK (
    platform IN ('facebook','instagram','tiktok','youtube','threads','linkedin','x','bluesky','meta_ads'));
ALTER TABLE job_ledger DROP CONSTRAINT job_ledger_platform_check,
  ADD CONSTRAINT job_ledger_platform_check CHECK (
    platform IN ('facebook','instagram','tiktok','youtube','threads','linkedin','x','bluesky','meta_ads'));

-- 2. One comment per platform comment id per connection, whichever source it came through.
CREATE UNIQUE INDEX comment_connection_id_external_id_key ON comment (connection_id, external_id);

-- 2b. The ad source a comment was polled through, when the comment is stored under a different source.
ALTER TABLE comment ADD COLUMN ad_source_id uuid,
  ADD CONSTRAINT comment_ad_source_id_fkey FOREIGN KEY (organization_id, brand_id, ad_source_id)
    REFERENCES source (organization_id, brand_id, id) ON DELETE SET NULL (ad_source_id);
CREATE INDEX comment_ad_source_id_idx ON comment (ad_source_id);

-- 3. Ads discovered through a meta_ads connection.
CREATE TABLE meta_ad (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  ads_connection_id uuid NOT NULL,
  external_id text NOT NULL,
  ad_account_external_id text NOT NULL,
  effective_status text NOT NULL,
  active boolean NOT NULL,
  inactive_since timestamptz(3),
  facebook_source_external_id text,
  instagram_source_external_id text,
  instagram_account_external_id text,
  facebook_resolution text NOT NULL,
  instagram_resolution text NOT NULL,
  first_discovered_at timestamptz(3) NOT NULL DEFAULT now(),
  last_discovered_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT meta_ad_pkey PRIMARY KEY (id),
  CONSTRAINT meta_ad_organization_id_brand_id_id_key UNIQUE (organization_id, brand_id, id),
  CONSTRAINT meta_ad_ads_connection_id_external_id_key UNIQUE (ads_connection_id, external_id),
  CONSTRAINT meta_ad_ads_connection_id_fkey FOREIGN KEY (organization_id, brand_id, ads_connection_id)
    REFERENCES connection (organization_id, brand_id, id) ON DELETE CASCADE,
  CONSTRAINT meta_ad_external_id_check CHECK (external_id ~ '^\d{1,32}$'),
  CONSTRAINT meta_ad_ad_account_external_id_check CHECK (ad_account_external_id ~ '^\d{1,32}$'),
  CONSTRAINT meta_ad_effective_status_check CHECK (effective_status ~ '^[A-Z_]{1,40}$'),
  CONSTRAINT meta_ad_inactive_since_check CHECK (active OR inactive_since IS NOT NULL),
  CONSTRAINT meta_ad_facebook_source_external_id_check CHECK (facebook_source_external_id ~ '^\d{1,32}_\d{1,32}$'),
  CONSTRAINT meta_ad_instagram_source_external_id_check CHECK (instagram_source_external_id ~ '^\d{1,32}$'),
  CONSTRAINT meta_ad_instagram_account_external_id_check CHECK (instagram_account_external_id ~ '^\d{1,32}$'),
  CONSTRAINT meta_ad_facebook_resolution_check CHECK (facebook_resolution IN
    ('linked','no_post','dynamic_creative_unsupported','post_deleted','invalid_platform_id','page_not_connected')),
  CONSTRAINT meta_ad_instagram_resolution_check CHECK (instagram_resolution IN
    ('linked','not_instagram','post_deleted','instagram_media_pending','invalid_platform_id','instagram_account_not_connected'))
);
CREATE TRIGGER meta_ad_set_updated_at_trg BEFORE UPDATE ON meta_ad
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- 4. Which sources an ad shows; one post behind many ads = many rows, one source.
CREATE TABLE meta_ad_source (
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  ad_id uuid NOT NULL,
  source_id uuid NOT NULL,
  platform text NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT meta_ad_source_pkey PRIMARY KEY (ad_id, source_id),
  CONSTRAINT meta_ad_source_ad_id_fkey FOREIGN KEY (organization_id, brand_id, ad_id)
    REFERENCES meta_ad (organization_id, brand_id, id) ON DELETE CASCADE,
  CONSTRAINT meta_ad_source_source_id_fkey FOREIGN KEY (organization_id, brand_id, source_id)
    REFERENCES source (organization_id, brand_id, id) ON DELETE CASCADE,
  CONSTRAINT meta_ad_source_platform_check CHECK (platform IN ('facebook','instagram'))
);
CREATE INDEX meta_ad_source_source_id_idx ON meta_ad_source (source_id);
CREATE TRIGGER meta_ad_source_set_updated_at_trg BEFORE UPDATE ON meta_ad_source
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- 5. Polling state per source (cursor, high-water mark, schedule).
CREATE TABLE source_poll (
  source_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  high_water_at timestamptz(3),
  resume_cursor text,
  resume_boundary timestamptz(3),
  last_polled_at timestamptz(3),
  last_full_scan_at timestamptz(3),
  last_comment_at timestamptz(3),
  next_poll_at timestamptz(3) NOT NULL DEFAULT now(),
  unavailable_since timestamptz(3),
  last_error_code text,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT source_poll_pkey PRIMARY KEY (source_id),
  CONSTRAINT source_poll_source_id_fkey FOREIGN KEY (organization_id, brand_id, connection_id, source_id)
    REFERENCES source (organization_id, brand_id, connection_id, id) ON DELETE CASCADE,
  CONSTRAINT source_poll_resume_cursor_check CHECK (char_length(resume_cursor) <= 2048),
  CONSTRAINT source_poll_last_error_code_check CHECK (last_error_code ~ '^[a-z][a-z0-9_]{0,62}$')
);
CREATE INDEX source_poll_connection_id_next_poll_at_idx ON source_poll (connection_id, next_poll_at);
CREATE TRIGGER source_poll_set_updated_at_trg BEFORE UPDATE ON source_poll
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

COMMIT;
