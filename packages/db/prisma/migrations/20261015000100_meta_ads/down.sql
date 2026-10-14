DROP TABLE source_poll;
DROP TABLE meta_ad_source;
DROP TABLE meta_ad;
DROP INDEX comment_ad_source_id_idx;
ALTER TABLE comment DROP CONSTRAINT comment_ad_source_id_fkey, DROP COLUMN ad_source_id;
ALTER TABLE comment DROP CONSTRAINT comment_connection_id_parent_comment_id_fkey,
  ADD CONSTRAINT comment_source_id_parent_comment_id_fkey FOREIGN KEY (source_id, parent_comment_id)
    REFERENCES comment (source_id, id) ON DELETE SET NULL (parent_comment_id);
ALTER TABLE comment DROP CONSTRAINT comment_connection_id_id_key;
DROP INDEX comment_connection_id_external_id_key;
ALTER TABLE job_ledger DROP CONSTRAINT job_ledger_platform_check,
  ADD CONSTRAINT job_ledger_platform_check CHECK (platform IN ('facebook','instagram','tiktok','youtube','threads','linkedin','x','bluesky'));
ALTER TABLE oauth_grant DROP CONSTRAINT oauth_grant_platform_check,
  ADD CONSTRAINT oauth_grant_platform_check CHECK (platform IN ('facebook','instagram','tiktok','youtube','threads','linkedin','x','bluesky'));
ALTER TABLE oauth_state DROP CONSTRAINT oauth_state_platform_check,
  ADD CONSTRAINT oauth_state_platform_check CHECK (platform IN ('facebook','instagram','tiktok','youtube','threads','linkedin','x','bluesky'));
ALTER TABLE connection DROP CONSTRAINT connection_platform_check,
  ADD CONSTRAINT connection_platform_check CHECK (platform IN ('facebook','instagram','tiktok','youtube','threads','linkedin','x','bluesky'));
ALTER TABLE source DROP CONSTRAINT source_organization_id_brand_id_id_key;
