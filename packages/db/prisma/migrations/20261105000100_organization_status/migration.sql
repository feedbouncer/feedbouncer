BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE organization
  ADD COLUMN status text NOT NULL DEFAULT 'active',
  ADD CONSTRAINT organization_status_check CHECK (status IN ('active', 'suspended'));

COMMIT;
