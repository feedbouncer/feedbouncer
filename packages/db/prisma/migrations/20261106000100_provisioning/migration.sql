BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE app_user
  ADD COLUMN status text NOT NULL DEFAULT 'active',
  ADD COLUMN external_ref text,
  ADD CONSTRAINT app_user_status_check CHECK (status IN ('active', 'suspended')),
  ADD CONSTRAINT app_user_external_ref_check CHECK (external_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$');
CREATE UNIQUE INDEX app_user_external_ref_key ON app_user (external_ref) WHERE external_ref IS NOT NULL;

ALTER TABLE organization
  ADD COLUMN external_ref text,
  ADD CONSTRAINT organization_external_ref_check CHECK (external_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$');
CREATE UNIQUE INDEX organization_external_ref_key ON organization (external_ref) WHERE external_ref IS NOT NULL;

CREATE TABLE provisioning_audit_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  credential_fingerprint text NOT NULL CHECK (credential_fingerprint ~ '^[0-9a-f]{12}$'),
  action text NOT NULL CHECK (action IN (
    'organization.create', 'organization.read', 'organization.set_status',
    'user.create', 'user.read', 'user.set_status')),
  target_type text NOT NULL CHECK (target_type IN ('organization', 'user')),
  target_id uuid,
  outcome text NOT NULL CHECK (outcome IN (
    'created', 'replayed', 'read', 'changed', 'unchanged',
    'not_found', 'conflict', 'invalid', 'failed')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX provisioning_audit_event_target_idx
  ON provisioning_audit_event (target_type, target_id, created_at DESC);
CREATE TRIGGER provisioning_audit_event_append_only_trg BEFORE UPDATE OR DELETE ON provisioning_audit_event
  FOR EACH ROW EXECUTE FUNCTION fb_forbid_direct_mutation();
CREATE TRIGGER provisioning_audit_event_no_truncate_trg BEFORE TRUNCATE ON provisioning_audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION fb_forbid_direct_mutation();

COMMIT;
