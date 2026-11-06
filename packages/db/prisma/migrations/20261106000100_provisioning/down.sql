DROP TABLE provisioning_audit_event;

DROP INDEX organization_external_ref_key;
ALTER TABLE organization
  DROP CONSTRAINT organization_external_ref_check,
  DROP COLUMN external_ref;

DROP INDEX app_user_external_ref_key;
ALTER TABLE app_user
  DROP CONSTRAINT app_user_external_ref_check,
  DROP CONSTRAINT app_user_status_check,
  DROP COLUMN external_ref,
  DROP COLUMN status;
