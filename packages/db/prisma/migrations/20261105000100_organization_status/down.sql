ALTER TABLE organization
  DROP CONSTRAINT organization_status_check,
  DROP COLUMN status;
