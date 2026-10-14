BEGIN;
SET LOCAL lock_timeout = '10s';

-- An ad listing in progress for a meta_ads connection: where the next job resumes,
-- and when the listing began (ads not seen since then are gone once it completes).
CREATE TABLE meta_ad_listing (
  ads_connection_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  cursor text NOT NULL,
  started_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT meta_ad_listing_pkey PRIMARY KEY (ads_connection_id),
  CONSTRAINT meta_ad_listing_ads_connection_id_fkey FOREIGN KEY (organization_id, brand_id, ads_connection_id)
    REFERENCES connection (organization_id, brand_id, id) ON DELETE CASCADE,
  CONSTRAINT meta_ad_listing_cursor_check CHECK (char_length(cursor) <= 2048)
);
CREATE TRIGGER meta_ad_listing_set_updated_at_trg BEFORE UPDATE ON meta_ad_listing
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

COMMIT;
