DROP INDEX comment_visible_organization_id_posted_at_idx;
ALTER TABLE meta_ad_source DROP COLUMN unlinked_at;
ALTER TABLE meta_ad
  DROP CONSTRAINT meta_ad_name_check,
  DROP COLUMN status_checked_at,
  DROP COLUMN deleted_at,
  DROP COLUMN name;
