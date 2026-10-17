-- Unified comments list: ads get a display name, a deletion mark and a last status check;
-- ad-to-source links can be unlinked softly; visible comments get a partial index for the
-- organization-wide list, newest first.
BEGIN;

SET LOCAL lock_timeout = '10s';

ALTER TABLE meta_ad
  ADD COLUMN name text,
  ADD COLUMN deleted_at timestamptz(3),
  ADD COLUMN status_checked_at timestamptz(3),
  ADD CONSTRAINT meta_ad_name_check CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 200);

ALTER TABLE meta_ad_source ADD COLUMN unlinked_at timestamptz(3);

CREATE INDEX comment_visible_organization_id_posted_at_idx
  ON comment (organization_id, posted_at DESC, id DESC)
  WHERE platform_state = 'visible' AND NOT is_own_account;

COMMIT;
