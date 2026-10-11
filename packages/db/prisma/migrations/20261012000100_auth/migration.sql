-- Identity (Better Auth tables, mapped to snake_case) and tenancy rules:
-- invitations, brand archiving/uniqueness, and the last-owner backstop.
-- See packages/db/README.md and the auth plan for the reasoning.
BEGIN;

SET LOCAL lock_timeout = '10s';

-- app_user: normalized email + Better Auth core fields.
UPDATE app_user SET email = lower(email) WHERE email <> lower(email);
ALTER TABLE app_user
  ADD COLUMN email_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN image text,
  ADD CONSTRAINT app_user_email_lower_check CHECK (email = lower(email)),
  ADD CONSTRAINT app_user_image_check CHECK (image IS NULL OR char_length(image) <= 2048);

CREATE TABLE auth_session (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  token text NOT NULL,
  expires_at timestamptz(3) NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT auth_session_pkey PRIMARY KEY (id),
  CONSTRAINT auth_session_token_key UNIQUE (token),
  CONSTRAINT auth_session_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES app_user (id) ON DELETE CASCADE
);
CREATE INDEX auth_session_user_id_idx ON auth_session (user_id);
CREATE INDEX auth_session_expires_at_idx ON auth_session (expires_at);
CREATE TRIGGER auth_session_set_updated_at_trg BEFORE UPDATE ON auth_session
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

CREATE TABLE auth_account (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  password_hash text,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT auth_account_pkey PRIMARY KEY (id),
  CONSTRAINT auth_account_provider_id_account_id_key UNIQUE (provider_id, account_id),
  CONSTRAINT auth_account_provider_id_check CHECK (provider_id IN ('credential')),
  CONSTRAINT auth_account_password_hash_check CHECK (
    (provider_id = 'credential') = (password_hash IS NOT NULL)),
  CONSTRAINT auth_account_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES app_user (id) ON DELETE CASCADE
);
CREATE INDEX auth_account_user_id_idx ON auth_account (user_id);
CREATE TRIGGER auth_account_set_updated_at_trg BEFORE UPDATE ON auth_account
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

CREATE TABLE auth_verification (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT auth_verification_pkey PRIMARY KEY (id)
);
CREATE INDEX auth_verification_identifier_idx ON auth_verification (identifier);
CREATE INDEX auth_verification_expires_at_idx ON auth_verification (expires_at);
CREATE TRIGGER auth_verification_set_updated_at_trg BEFORE UPDATE ON auth_verification
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

CREATE TABLE invitation (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  email text NOT NULL,
  role text NOT NULL,
  token_hash bytea NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz(3) NOT NULL,
  invited_by_user_id uuid,
  accepted_by_user_id uuid,
  accepted_at timestamptz(3),
  revoked_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT invitation_pkey PRIMARY KEY (id),
  CONSTRAINT invitation_token_hash_key UNIQUE (token_hash),
  CONSTRAINT invitation_role_check CHECK (role IN ('owner', 'admin', 'member')),
  CONSTRAINT invitation_status_check CHECK (status IN ('pending', 'accepted', 'revoked')),
  CONSTRAINT invitation_email_check CHECK (
    char_length(email) BETWEEN 3 AND 320 AND email = lower(btrim(email)) AND position('@' IN email) > 1),
  CONSTRAINT invitation_token_hash_check CHECK (octet_length(token_hash) = 32),
  CONSTRAINT invitation_state_check CHECK (
    (status = 'pending'  AND accepted_at IS NULL     AND revoked_at IS NULL) OR
    (status = 'accepted' AND accepted_at IS NOT NULL AND revoked_at IS NULL) OR
    (status = 'revoked'  AND revoked_at IS NOT NULL  AND accepted_at IS NULL)),
  CONSTRAINT invitation_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES organization (id) ON DELETE CASCADE,
  CONSTRAINT invitation_invited_by_user_id_fkey FOREIGN KEY (invited_by_user_id)
    REFERENCES app_user (id) ON DELETE SET NULL,
  CONSTRAINT invitation_accepted_by_user_id_fkey FOREIGN KEY (accepted_by_user_id)
    REFERENCES app_user (id) ON DELETE SET NULL
);
CREATE INDEX invitation_organization_id_status_idx ON invitation (organization_id, status);
CREATE UNIQUE INDEX invitation_organization_id_email_key ON invitation (organization_id, email)
  WHERE status = 'pending';
CREATE INDEX invitation_invited_by_user_id_idx ON invitation (invited_by_user_id)
  WHERE invited_by_user_id IS NOT NULL;
CREATE INDEX invitation_accepted_by_user_id_idx ON invitation (accepted_by_user_id)
  WHERE accepted_by_user_id IS NOT NULL;
CREATE TRIGGER invitation_set_updated_at_trg BEFORE UPDATE ON invitation
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- brand: archive instead of delete; names unique among active brands per org.
ALTER TABLE brand ADD COLUMN archived_at timestamptz(3);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM brand GROUP BY organization_id, lower(btrim(name)) HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'brand names must be unique per organization before this migration; rename duplicates first';
  END IF;
END
$$;
CREATE UNIQUE INDEX brand_organization_id_name_key ON brand (organization_id, lower(btrim(name)))
  WHERE archived_at IS NULL;

-- Last-owner backstop. Checked at COMMIT (deferred), so a transaction may add a
-- new owner and demote the old one in any order. An organization deleted in the
-- same transaction no longer exists, so its cascade passes. A user deletion that
-- would orphan an organization fails. Tables are schema-qualified because
-- search_path is pinned.
CREATE FUNCTION fb_require_org_owner() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  locked uuid;
BEGIN
  -- Serialize concurrent owner changes per organization. Under READ COMMITTED
  -- the owner check below runs after the lock is granted, so it sees the
  -- result of any transaction that committed first. No row means the
  -- organization is gone (deleted in this or another transaction).
  SELECT o.id INTO locked FROM public.organization o
   WHERE o.id = OLD.organization_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.membership m
                  WHERE m.organization_id = OLD.organization_id AND m.role = 'owner') THEN
    RAISE EXCEPTION 'organization % must keep at least one owner', OLD.organization_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'membership_owner_required';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER membership_require_owner_trg
  AFTER UPDATE OF role, organization_id OR DELETE ON membership
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fb_require_org_owner();

COMMIT;
