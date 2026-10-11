DROP TRIGGER membership_require_owner_trg ON membership;
DROP FUNCTION fb_require_org_owner();
DROP INDEX brand_organization_id_name_key;
ALTER TABLE brand DROP COLUMN archived_at;
DROP TABLE invitation;
DROP TABLE auth_verification;
DROP TABLE auth_account;
DROP TABLE auth_session;
ALTER TABLE app_user
  DROP CONSTRAINT app_user_image_check,
  DROP CONSTRAINT app_user_email_lower_check,
  DROP COLUMN image,
  DROP COLUMN email_verified;
