ALTER TABLE rule DROP CONSTRAINT rule_applies_to_check, DROP COLUMN applies_to;
ALTER TABLE connection DROP CONSTRAINT connection_missing_scopes_check, DROP COLUMN missing_scopes;
DROP TABLE connection_poll;
-- Destructive rollback: rows on the tiktok_ads platform cannot satisfy the restored checks, so they are deleted.
DELETE FROM job_ledger WHERE platform = 'tiktok_ads';
DELETE FROM oauth_grant WHERE platform = 'tiktok_ads';
DELETE FROM oauth_state WHERE platform = 'tiktok_ads';
DELETE FROM connection WHERE platform = 'tiktok_ads';
ALTER TABLE connection DROP CONSTRAINT connection_platform_check,
  ADD CONSTRAINT connection_platform_check CHECK (platform IN ('facebook','instagram','tiktok','youtube','threads','linkedin','x','bluesky','meta_ads'));
ALTER TABLE oauth_state DROP CONSTRAINT oauth_state_platform_check,
  ADD CONSTRAINT oauth_state_platform_check CHECK (platform IN ('facebook','instagram','tiktok','youtube','threads','linkedin','x','bluesky','meta_ads'));
ALTER TABLE oauth_grant DROP CONSTRAINT oauth_grant_platform_check,
  ADD CONSTRAINT oauth_grant_platform_check CHECK (platform IN ('facebook','instagram','tiktok','youtube','threads','linkedin','x','bluesky','meta_ads'));
ALTER TABLE job_ledger DROP CONSTRAINT job_ledger_platform_check,
  ADD CONSTRAINT job_ledger_platform_check CHECK (platform IN ('facebook','instagram','tiktok','youtube','threads','linkedin','x','bluesky','meta_ads'));
